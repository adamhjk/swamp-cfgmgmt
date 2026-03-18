import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Absolute path of the file on the remote node"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether file should be present or absent",
  ),
  content: z.string().optional().describe("Desired file content"),
  owner: z.string().optional().describe("File owner"),
  group: z.string().optional().describe("File group"),
  mode: z.string().optional().describe("File permissions in octal (e.g. 0644)"),
  nodeHost: z.string().describe("Hostname or IP of the remote node"),
  nodeUser: z.string().default("root").describe("SSH username"),
  nodePort: z.number().default(22).describe("SSH port"),
  nodeIdentityFile: z.string().optional().describe("Path to SSH private key"),
  become: z.boolean().default(false).describe(
    "Enable sudo privilege escalation",
  ),
  becomeUser: z.string().default("root").describe("User to become via sudo"),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "Password for sudo -S",
  ),
});

function sudoOpts(g) {
  return {
    become: g.become,
    becomeUser: g.becomeUser,
    becomePassword: g.becomePassword,
  };
}

const StateSchema = z.object({
  path: z.string().describe("File path"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the file currently exists"),
    isFile: z.boolean().describe("Whether the path is a regular file"),
    owner: z.string().nullable().describe("Current file owner"),
    group: z.string().nullable().describe("Current file group"),
    mode: z.string().nullable().describe("Current permissions (e.g. 0644)"),
    contentSha256: z.string().nullable().describe(
      "SHA-256 hash of current content",
    ),
  }).describe("Current file state on the remote node"),
  changes: z.array(z.string()).describe("List of changes detected or applied"),
  error: z.string().nullable().describe("Error message if status is failed"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

function connect(g) {
  return getConnection({
    host: g.nodeHost,
    port: g.nodePort,
    username: g.nodeUser,
    privateKeyPath: g.nodeIdentityFile,
  });
}

async function gather(client, path, g) {
  const so = sudoOpts(g);
  const statResult = await exec(
    client,
    wrapSudo(
      `stat -c '%F|%U|%G|%a' ${
        JSON.stringify(path)
      } 2>/dev/null || echo 'NOTFOUND'`,
      so,
    ),
  );
  const line = statResult.stdout.trim();
  if (line === "NOTFOUND") {
    return {
      exists: false,
      isFile: false,
      owner: null,
      group: null,
      mode: null,
      contentSha256: null,
    };
  }
  const parts = line.split("|");
  if (parts.length < 4) {
    return {
      exists: false,
      isFile: false,
      owner: null,
      group: null,
      mode: null,
      contentSha256: null,
    };
  }
  const [fileType, owner, group, mode] = parts;
  const isFile = fileType === "regular file" ||
    fileType === "regular empty file";

  let contentSha256 = null;
  if (isFile) {
    const hashResult = await exec(
      client,
      wrapSudo(
        `sha256sum ${JSON.stringify(path)} 2>/dev/null | awk '{print $1}'`,
        so,
      ),
    );
    contentSha256 = hashResult.stdout.trim() || null;
  }

  return {
    exists: true,
    isFile,
    owner,
    group,
    mode: `0${mode}`,
    contentSha256,
  };
}

function computeDesiredHash(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  return crypto.subtle.digest("SHA-256", data).then(
    (buf) =>
      Array.from(new Uint8Array(buf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
  );
}

function detectChanges(g, current) {
  const changes = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create file");
    } else if (!current.isFile) {
      changes.push("path exists but is not a regular file");
    }
    if (g.owner && current.owner !== g.owner) {
      changes.push(`owner: ${current.owner} -> ${g.owner}`);
    }
    if (g.group && current.group !== g.group) {
      changes.push(`group: ${current.group} -> ${g.group}`);
    }
    if (g.mode && current.mode !== g.mode) {
      changes.push(`mode: ${current.mode} -> ${g.mode}`);
    }
  } else {
    if (current.exists) changes.push("remove file");
  }
  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/file",
  version: "2026.03.02.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({
    nodeHost: z.string().optional().describe(
      "Hostname or IP of the remote node",
    ),
    nodeUser: z.string().optional().describe("SSH username"),
    nodePort: z.number().optional().describe("SSH port"),
    nodeIdentityFile: z.string().optional().describe("Path to SSH private key"),
    become: z.boolean().optional().describe("Enable sudo privilege escalation"),
    becomeUser: z.string().optional().describe("User to become via sudo"),
    becomePassword: z.string().optional().describe("Password for sudo -S"),
  }),
  resources: {
    state: {
      description: "Result of check or apply operation",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check if file matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);

          if (
            g.ensure === "present" && g.content !== undefined &&
            current.isFile && current.contentSha256
          ) {
            const desiredHash = await computeDesiredHash(g.content);
            if (current.contentSha256 !== desiredHash) {
              changes.push("content differs");
            }
          }

          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            ensure: g.ensure,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
            ensure: g.ensure,
            status: "failed",
            current: {
              exists: false,
              isFile: false,
              owner: null,
              group: null,
              mode: null,
              contentSha256: null,
            },
            changes: [],
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    apply: {
      description: "Apply desired file state to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);

          if (
            g.ensure === "present" && g.content !== undefined &&
            current.isFile && current.contentSha256
          ) {
            const desiredHash = await computeDesiredHash(g.content);
            if (current.contentSha256 !== desiredHash) {
              changes.push("content differs");
            }
          }

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              path: g.path,
              ensure: g.ensure,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);
          if (g.ensure === "absent") {
            await exec(client, wrapSudo(`rm -f ${JSON.stringify(g.path)}`, so));
          } else {
            const dir = g.path.substring(0, g.path.lastIndexOf("/"));
            if (dir) {
              await exec(
                client,
                wrapSudo(`mkdir -p ${JSON.stringify(dir)}`, so),
              );
            }
            if (g.content !== undefined) {
              await writeFileAs(client, g.path, g.content, so);
            }
            if (g.owner || g.group) {
              const ownership = g.group
                ? `${g.owner || ""}:${g.group}`
                : g.owner;
              await exec(
                client,
                wrapSudo(
                  `chown ${JSON.stringify(ownership)} ${
                    JSON.stringify(g.path)
                  }`,
                  so,
                ),
              );
            }
            if (g.mode) {
              await exec(
                client,
                wrapSudo(`chmod ${g.mode} ${JSON.stringify(g.path)}`, so),
              );
            }
          }

          const updated = await gather(client, g.path, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            ensure: g.ensure,
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
            ensure: g.ensure,
            status: "failed",
            current: {
              exists: false,
              isFile: false,
              owner: null,
              group: null,
              mode: null,
              contentSha256: null,
            },
            changes: [],
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
  },
};

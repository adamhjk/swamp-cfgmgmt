import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Absolute path of the directory"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether directory should be present or absent",
  ),
  owner: z.string().optional().describe("Directory owner"),
  group: z.string().optional().describe("Directory group"),
  mode: z.string().regex(/^[0-7]{3,4}$/, "Mode must be 3-4 octal digits")
    .optional().describe(
      "Directory permissions in octal (e.g. 0755)",
    ),
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
  path: z.string().describe("Directory path"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the directory currently exists"),
    isDirectory: z.boolean().describe("Whether the path is a directory"),
    owner: z.string().nullable().describe("Current owner"),
    group: z.string().nullable().describe("Current group"),
    mode: z.string().nullable().describe("Current permissions"),
  }).describe("Current directory state on the remote node"),
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
  const statResult = await execSudo(
    client,
    `stat -c '%F|%U|%G|%a' ${shellEscape(path)} 2>/dev/null || echo 'NOTFOUND'`,
    so,
  );
  const line = statResult.stdout.trim();
  if (line === "NOTFOUND") {
    return {
      exists: false,
      isDirectory: false,
      owner: null,
      group: null,
      mode: null,
    };
  }
  const parts = line.split("|");
  if (parts.length < 4) {
    return {
      exists: false,
      isDirectory: false,
      owner: null,
      group: null,
      mode: null,
    };
  }
  const [fileType, owner, group, mode] = parts;
  return {
    exists: true,
    isDirectory: fileType === "directory",
    owner,
    group,
    mode: `0${mode}`,
  };
}

function detectChanges(g, current) {
  const changes = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create directory");
    } else if (!current.isDirectory) {
      changes.push("path exists but is not a directory");
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
    if (current.exists) changes.push("remove directory");
  }
  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/directory",
  version: "2026.03.18.1",
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
    becomePassword: z.string().optional().meta({ sensitive: true }).describe(
      "Password for sudo -S",
    ),
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
      description: "Check if directory matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);
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
              isDirectory: false,
              owner: null,
              group: null,
              mode: null,
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
      description: "Apply desired directory state to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);

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
            await execSudo(
              client,
              `rm -rf ${shellEscape(g.path)}`,
              so,
            );
          } else {
            await execSudo(
              client,
              `mkdir -p ${shellEscape(g.path)}`,
              so,
            );
            if (g.owner || g.group) {
              const ownership = g.group
                ? `${g.owner || ""}:${g.group}`
                : g.owner;
              await execSudo(
                client,
                `chown ${shellEscape(ownership)} ${shellEscape(g.path)}`,
                so,
              );
            }
            if (g.mode) {
              await execSudo(
                client,
                `chmod ${g.mode} ${shellEscape(g.path)}`,
                so,
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
              isDirectory: false,
              owner: null,
              group: null,
              mode: null,
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
  reports: [],
};

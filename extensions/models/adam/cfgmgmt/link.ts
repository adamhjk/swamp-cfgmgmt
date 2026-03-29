import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Path where the symlink should exist"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether symlink should be present or absent",
  ),
  target: z.string().optional().describe("Target the symlink should point to"),
  owner: z.string().optional().describe("Symlink owner"),
  group: z.string().optional().describe("Symlink group"),
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
  path: z.string().describe("Symlink path"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether something exists at the path"),
    isLink: z.boolean().describe("Whether the path is a symbolic link"),
    linkTarget: z.string().nullable().describe("Current symlink target"),
    owner: z.string().nullable().describe("Current owner"),
    group: z.string().nullable().describe("Current group"),
  }).describe("Current symlink state on the remote node"),
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
  const testResult = await execSudo(
    client,
    `test -L ${shellEscape(path)} && echo ISLINK || echo NOTLINK`,
    so,
  );
  const isLink = testResult.stdout.trim() === "ISLINK";

  if (!isLink) {
    const existsResult = await execSudo(
      client,
      `test -e ${shellEscape(path)} && echo EXISTS || echo NOTEXISTS`,
      so,
    );
    if (existsResult.stdout.trim() === "NOTEXISTS") {
      return {
        exists: false,
        isLink: false,
        linkTarget: null,
        owner: null,
        group: null,
      };
    }
    const statResult = await execSudo(
      client,
      `stat -c '%U|%G' ${shellEscape(path)} 2>/dev/null`,
      so,
    );
    const parts1 = statResult.stdout.trim().split("|");
    const owner1 = parts1.length >= 2 ? parts1[0] || null : null;
    const group1 = parts1.length >= 2 ? parts1[1] || null : null;
    return {
      exists: true,
      isLink: false,
      linkTarget: null,
      owner: owner1,
      group: group1,
    };
  }

  const targetResult = await execSudo(
    client,
    `readlink ${shellEscape(path)}`,
    so,
  );
  const linkTarget = targetResult.stdout.trim();

  const statResult = await execSudo(
    client,
    `stat -c '%U|%G' ${shellEscape(path)} 2>/dev/null`,
    so,
  );
  const parts2 = statResult.stdout.trim().split("|");
  const owner = parts2.length >= 2 ? parts2[0] || null : null;
  const group = parts2.length >= 2 ? parts2[1] || null : null;

  return { exists: true, isLink: true, linkTarget, owner, group };
}

function detectChanges(g, current) {
  const changes = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create symlink");
    } else if (!current.isLink) {
      changes.push("path exists but is not a symlink");
    } else if (g.target && current.linkTarget !== g.target) {
      changes.push(`target: ${current.linkTarget} -> ${g.target}`);
    }
    if (g.owner && current.owner !== g.owner) {
      changes.push(`owner: ${current.owner} -> ${g.owner}`);
    }
    if (g.group && current.group !== g.group) {
      changes.push(`group: ${current.group} -> ${g.group}`);
    }
  } else {
    if (current.exists) changes.push("remove symlink");
  }
  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/link",
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
      description: "Check if symlink matches desired state (dry-run)",
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
              isLink: false,
              linkTarget: null,
              owner: null,
              group: null,
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
      description: "Apply desired symlink state to the remote node",
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
            await execSudo(client, `rm -f ${shellEscape(g.path)}`, so);
          } else {
            await execSudo(
              client,
              `ln -sfn ${shellEscape(g.target)} ${shellEscape(g.path)}`,
              so,
            );
            if (g.owner || g.group) {
              const ownership = g.group
                ? `${g.owner || ""}:${g.group}`
                : g.owner;
              await execSudo(
                client,
                `chown -h ${shellEscape(ownership)} ${shellEscape(g.path)}`,
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
              isLink: false,
              linkTarget: null,
              owner: null,
              group: null,
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

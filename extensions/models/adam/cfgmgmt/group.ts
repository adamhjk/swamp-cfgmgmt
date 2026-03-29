import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  groupname: z.string().describe("Group name to manage"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether group should be present or absent",
  ),
  gid: z.number().optional().describe("Desired GID"),
  members: z.array(z.string()).optional().describe("Group members"),
  system: z.boolean().optional().describe("Create as system group"),
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
  groupname: z.string().describe("Group name"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the group currently exists"),
    gid: z.number().nullable().describe("Current GID"),
    members: z.array(z.string()).describe("Current group members"),
  }).describe("Current group state on the remote node"),
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

async function gather(client, groupname, g) {
  const so = sudoOpts(g);
  const result = await execSudo(
    client,
    `getent group ${shellEscape(groupname)} 2>/dev/null || echo 'NOTFOUND'`,
    so,
  );
  const line = result.stdout.trim();
  if (line === "NOTFOUND" || !line) {
    return {
      exists: false,
      gid: null,
      members: [] as string[],
    };
  }
  const parts = line.split(":");
  const gid = parseInt(parts[2], 10);
  const members = parts[3] ? parts[3].split(",").filter((m) => m).sort() : [];
  return { exists: true, gid, members };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create group");
    } else {
      if (g.gid !== undefined && current.gid !== g.gid) {
        changes.push(`gid: ${current.gid} -> ${g.gid}`);
      }
      if (g.members !== undefined) {
        const desired = [...g.members].sort();
        const have = [...current.members].sort();
        if (JSON.stringify(desired) !== JSON.stringify(have)) {
          changes.push(
            `members: [${have.join(",")}] -> [${desired.join(",")}]`,
          );
        }
      }
    }
  } else {
    if (current.exists) changes.push("remove group");
  }
  return changes;
}

function emptyCurrent() {
  return { exists: false, gid: null, members: [] as string[] };
}

export const model = {
  type: "@adam/cfgmgmt/group",
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
      description: "Check if group matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.groupname, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            groupname: g.groupname,
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
            groupname: g.groupname,
            ensure: g.ensure,
            status: "failed",
            current: emptyCurrent(),
            changes: [],
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    apply: {
      description: "Create, modify, or remove a system group",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.groupname, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              groupname: g.groupname,
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
            const result = await execSudo(
              client,
              `groupdel ${shellEscape(g.groupname)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`groupdel failed: ${result.stderr}`);
            }
          } else if (!current.exists) {
            const args: string[] = [];
            if (g.gid !== undefined) args.push("-g", String(g.gid));
            if (g.system) args.push("-r");
            args.push(g.groupname);
            const result = await execSudo(
              client,
              `groupadd ${args.join(" ")}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`groupadd failed: ${result.stderr}`);
            }
            if (g.members !== undefined && g.members.length > 0) {
              const memberResult = await execSudo(
                client,
                `gpasswd -M ${shellEscape(g.members.join(","))} ${
                  shellEscape(g.groupname)
                }`,
                so,
              );
              if (memberResult.exitCode !== 0) {
                throw new Error(
                  `gpasswd -M failed: ${memberResult.stderr}`,
                );
              }
            }
          } else {
            if (g.gid !== undefined && current.gid !== g.gid) {
              const result = await execSudo(
                client,
                `groupmod -g ${g.gid} ${shellEscape(g.groupname)}`,
                so,
              );
              if (result.exitCode !== 0) {
                throw new Error(`groupmod failed: ${result.stderr}`);
              }
            }
            if (g.members !== undefined) {
              const desired = [...g.members].sort();
              const have = [...current.members].sort();
              if (JSON.stringify(desired) !== JSON.stringify(have)) {
                const memberList = g.members.join(",");
                const result = await execSudo(
                  client,
                  `gpasswd -M ${shellEscape(memberList) || '""'} ${
                    shellEscape(g.groupname)
                  }`,
                  so,
                );
                if (result.exitCode !== 0) {
                  throw new Error(
                    `gpasswd -M failed: ${result.stderr}`,
                  );
                }
              }
            }
          }

          const updated = await gather(client, g.groupname, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            groupname: g.groupname,
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
            groupname: g.groupname,
            ensure: g.ensure,
            status: "failed",
            current: emptyCurrent(),
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

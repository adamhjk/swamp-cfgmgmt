import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  username: z.string().describe("Username to manage"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether user should be present or absent",
  ),
  uid: z.number().optional().describe("Desired UID"),
  gid: z.number().optional().describe("Desired primary GID"),
  groups: z.array(z.string()).optional().describe(
    "Supplementary groups",
  ),
  home: z.string().optional().describe("Home directory path"),
  shell: z.string().optional().describe("Login shell"),
  system: z.boolean().optional().describe("Create as system user"),
  managehome: z.boolean().default(false).describe(
    "Manage home directory (create with useradd -m, remove with userdel -r)",
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
  username: z.string().describe("Username"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the user currently exists"),
    uid: z.number().nullable().describe("Current UID"),
    gid: z.number().nullable().describe("Current primary GID"),
    groups: z.array(z.string()).describe("Current supplementary groups"),
    home: z.string().nullable().describe("Current home directory"),
    shell: z.string().nullable().describe("Current login shell"),
  }).describe("Current user state on the remote node"),
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

async function gather(client, username, g) {
  const so = sudoOpts(g);
  const pw = await exec(
    client,
    wrapSudo(
      `getent passwd ${
        JSON.stringify(username)
      } 2>/dev/null || echo 'NOTFOUND'`,
      so,
    ),
  );
  const line = pw.stdout.trim();
  if (line === "NOTFOUND" || !line) {
    return {
      exists: false,
      uid: null,
      gid: null,
      groups: [] as string[],
      home: null,
      shell: null,
    };
  }
  const parts = line.split(":");
  const uid = parseInt(parts[2], 10);
  const gid = parseInt(parts[3], 10);
  const home = parts[5];
  const shell = parts[6];

  const primaryGroup = await exec(
    client,
    wrapSudo(`id -gn ${JSON.stringify(username)} 2>/dev/null`, so),
  );
  const primaryGroupName = primaryGroup.stdout.trim();

  const allGroups = await exec(
    client,
    wrapSudo(`id -nG ${JSON.stringify(username)} 2>/dev/null`, so),
  );
  const groupList = allGroups.stdout.trim().split(/\s+/).filter((g) =>
    g && g !== primaryGroupName
  );

  return { exists: true, uid, gid, groups: groupList.sort(), home, shell };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create user");
    } else {
      if (g.uid !== undefined && current.uid !== g.uid) {
        changes.push(`uid: ${current.uid} -> ${g.uid}`);
      }
      if (g.gid !== undefined && current.gid !== g.gid) {
        changes.push(`gid: ${current.gid} -> ${g.gid}`);
      }
      if (g.home !== undefined && current.home !== g.home) {
        changes.push(`home: ${current.home} -> ${g.home}`);
      }
      if (g.shell !== undefined && current.shell !== g.shell) {
        changes.push(`shell: ${current.shell} -> ${g.shell}`);
      }
      if (g.groups !== undefined) {
        const desired = [...g.groups].sort();
        const have = [...current.groups].sort();
        if (JSON.stringify(desired) !== JSON.stringify(have)) {
          changes.push(
            `groups: [${have.join(",")}] -> [${desired.join(",")}]`,
          );
        }
      }
    }
  } else {
    if (current.exists) changes.push("remove user");
  }
  return changes;
}

function emptyCurrent() {
  return {
    exists: false,
    uid: null,
    gid: null,
    groups: [] as string[],
    home: null,
    shell: null,
  };
}

export const model = {
  type: "@adam/cfgmgmt/user",
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
      description: "Check if user matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.username, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            username: g.username,
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
            username: g.username,
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
      description: "Create, modify, or remove a system user",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.username, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              username: g.username,
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
            const flags = g.managehome ? "-r" : "";
            const result = await exec(
              client,
              wrapSudo(
                `userdel ${flags} ${JSON.stringify(g.username)}`,
                so,
              ),
            );
            if (result.exitCode !== 0) {
              throw new Error(`userdel failed: ${result.stderr}`);
            }
          } else if (!current.exists) {
            const args: string[] = [];
            if (g.uid !== undefined) args.push("-u", String(g.uid));
            if (g.gid !== undefined) args.push("-g", String(g.gid));
            if (g.groups !== undefined && g.groups.length > 0) {
              args.push("-G", g.groups.join(","));
            }
            if (g.home !== undefined) args.push("-d", g.home);
            if (g.shell !== undefined) args.push("-s", g.shell);
            if (g.system) args.push("-r");
            if (g.managehome) args.push("-m");
            args.push(g.username);
            const result = await exec(
              client,
              wrapSudo(`useradd ${args.join(" ")}`, so),
            );
            if (result.exitCode !== 0) {
              throw new Error(`useradd failed: ${result.stderr}`);
            }
          } else {
            const args: string[] = [];
            if (g.uid !== undefined && current.uid !== g.uid) {
              args.push("-u", String(g.uid));
            }
            if (g.gid !== undefined && current.gid !== g.gid) {
              args.push("-g", String(g.gid));
            }
            if (g.groups !== undefined) {
              args.push("-G", g.groups.join(","));
            }
            if (g.home !== undefined && current.home !== g.home) {
              args.push("-d", g.home);
              if (g.managehome) args.push("-m");
            }
            if (g.shell !== undefined && current.shell !== g.shell) {
              args.push("-s", g.shell);
            }
            if (args.length > 0) {
              args.push(g.username);
              const result = await exec(
                client,
                wrapSudo(`usermod ${args.join(" ")}`, so),
              );
              if (result.exitCode !== 0) {
                throw new Error(`usermod failed: ${result.stderr}`);
              }
            }
          }

          const updated = await gather(client, g.username, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            username: g.username,
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
            username: g.username,
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

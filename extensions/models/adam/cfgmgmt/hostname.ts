import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe("Desired system hostname"),
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
  name: z.string().describe("Desired hostname"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    hostname: z.string().nullable().describe("Current live hostname"),
    etcHostname: z.string().nullable().describe(
      "Current contents of /etc/hostname",
    ),
  }).describe("Current hostname state on the remote node"),
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

async function gather(client, g) {
  const so = sudoOpts(g);
  const hostnameResult = await exec(
    client,
    wrapSudo(
      `hostnamectl --static 2>/dev/null || hostname`,
      so,
    ),
  );
  const etcResult = await exec(
    client,
    wrapSudo(`cat /etc/hostname 2>/dev/null || echo ''`, so),
  );
  return {
    hostname: hostnameResult.stdout.trim() || null,
    etcHostname: etcResult.stdout.trim() || null,
  };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (current.hostname !== g.name) {
    changes.push(`hostname: ${current.hostname} -> ${g.name}`);
  }
  if (current.etcHostname !== g.name) {
    changes.push(`/etc/hostname: ${current.etcHostname} -> ${g.name}`);
  }
  return changes;
}

function emptyCurrent() {
  return { hostname: null, etcHostname: null };
}

export const model = {
  type: "@adam/cfgmgmt/hostname",
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
      description: "Check if hostname matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            name: g.name,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            name: g.name,
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
      description: "Set the system hostname to the desired value",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              name: g.name,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);
          const hostnamectlCheck = await exec(
            client,
            wrapSudo("command -v hostnamectl", so),
          );
          if (hostnamectlCheck.exitCode === 0) {
            await exec(
              client,
              wrapSudo(
                `hostnamectl set-hostname ${JSON.stringify(g.name)}`,
                so,
              ),
            );
          } else {
            await writeFileAs(client, "/etc/hostname", g.name + "\n", so);
            await exec(
              client,
              wrapSudo(`hostname ${JSON.stringify(g.name)}`, so),
            );
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            name: g.name,
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            name: g.name,
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

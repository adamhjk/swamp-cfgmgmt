import { z } from "npm:zod@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  key: z.string().describe("Sysctl key (e.g. net.ipv4.ip_forward)"),
  value: z.string().describe("Desired value"),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether the sysctl parameter should be present or absent",
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
  key: z.string().describe("Sysctl key"),
  value: z.string().describe("Desired value"),
  ensure: z.string().describe("Desired state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    liveValue: z.string().nullable().describe("Current live kernel value"),
    persisted: z.boolean().describe("Whether a persistence file exists"),
    persistedValue: z.string().nullable().describe("Value in persistence file"),
  }).describe("Current sysctl state"),
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

function confPath(key: string): string {
  return `/etc/sysctl.d/99-cfgmgmt-${key.replace(/\./g, "-")}.conf`;
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const liveResult = await execSudo(
    client,
    `sysctl -n ${shellEscape(g.key)} 2>/dev/null`,
    so,
  );
  const liveValue = liveResult.exitCode === 0 ? liveResult.stdout.trim() : null;

  const path = confPath(g.key);
  const fileResult = await execSudo(
    client,
    `cat ${shellEscape(path)} 2>/dev/null`,
    so,
  );

  let persisted = false;
  let persistedValue: string | null = null;
  if (fileResult.exitCode === 0 && fileResult.stdout.trim()) {
    persisted = true;
    const match = fileResult.stdout.match(/=\s*(.+)/);
    persistedValue = match ? match[1].trim() : null;
  }

  return { liveValue, persisted, persistedValue };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (current.liveValue !== g.value) {
      changes.push(`live value: ${current.liveValue} -> ${g.value}`);
    }
    if (!current.persisted || current.persistedValue !== g.value) {
      changes.push("update persistence file");
    }
  } else {
    if (current.persisted) {
      changes.push("remove persistence file");
    }
  }
  return changes;
}

function emptyCurrent() {
  return { liveValue: null, persisted: false, persistedValue: null };
}

export const model = {
  type: "@adam/cfgmgmt/sysctl",
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
      description: "Check if sysctl parameter matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            key: g.key,
            value: g.value,
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
            key: g.key,
            value: g.value,
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
      description: "Set or remove a sysctl kernel parameter",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              key: g.key,
              value: g.value,
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
          const path = confPath(g.key);

          if (g.ensure === "present") {
            await writeFileAs(
              client,
              path,
              `${g.key} = ${g.value}\n`,
              so,
            );
            const result = await execSudo(
              client,
              `sysctl -w ${shellEscape(g.key + "=" + g.value)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`sysctl -w failed: ${result.stderr}`);
            }
          } else {
            await execSudo(
              client,
              `rm -f ${shellEscape(path)}`,
              so,
            );
            await execSudo(client, `sysctl --system`, so);
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            key: g.key,
            value: g.value,
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
            key: g.key,
            value: g.value,
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

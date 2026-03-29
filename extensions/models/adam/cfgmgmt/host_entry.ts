import { z } from "npm:zod@4";
import { execSudo, getConnection, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  hostname: z.string().describe("Primary hostname for the /etc/hosts entry"),
  ip: z.string().describe("IP address for the entry"),
  aliases: z.array(z.string()).optional().describe(
    "Additional hostname aliases",
  ),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether the entry should be present or absent",
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
  hostname: z.string().describe("Primary hostname"),
  ip: z.string().describe("IP address"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    entryExists: z.boolean().describe("Whether a matching entry exists"),
    currentIp: z.string().nullable().describe("Current IP for the hostname"),
    currentAliases: z.array(z.string()).describe("Current aliases"),
  }).describe("Current /etc/hosts state"),
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

function parseHostsEntry(lines: string[], hostname: string) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const hostnames = parts.slice(1);
    if (hostnames.includes(hostname)) {
      return {
        entryExists: true,
        currentIp: parts[0],
        currentAliases: hostnames.filter((h) => h !== hostname).sort(),
      };
    }
  }
  return {
    entryExists: false,
    currentIp: null,
    currentAliases: [] as string[],
  };
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const result = await execSudo(
    client,
    `cat /etc/hosts 2>/dev/null || echo ''`,
    so,
  );
  const lines = result.stdout.split("\n");
  return parseHostsEntry(lines, g.hostname);
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (!current.entryExists) {
      changes.push("add entry");
    } else {
      if (current.currentIp !== g.ip) {
        changes.push(`ip: ${current.currentIp} -> ${g.ip}`);
      }
      const desiredAliases = g.aliases ? [...g.aliases].sort() : [];
      if (
        JSON.stringify(current.currentAliases) !==
          JSON.stringify(desiredAliases)
      ) {
        changes.push(
          `aliases: [${current.currentAliases.join(",")}] -> [${
            desiredAliases.join(",")
          }]`,
        );
      }
    }
  } else {
    if (current.entryExists) changes.push("remove entry");
  }
  return changes;
}

function emptyCurrent() {
  return {
    entryExists: false,
    currentIp: null,
    currentAliases: [] as string[],
  };
}

export const model = {
  type: "@adam/cfgmgmt/host_entry",
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
      description: "Check if /etc/hosts entry matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            hostname: g.hostname,
            ip: g.ip,
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
            hostname: g.hostname,
            ip: g.ip,
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
      description: "Add, update, or remove an /etc/hosts entry",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              hostname: g.hostname,
              ip: g.ip,
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
          const hostsResult = await execSudo(
            client,
            `cat /etc/hosts 2>/dev/null || echo ''`,
            so,
          );
          const lines = hostsResult.stdout.split("\n");

          const filtered = lines.filter((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return true;
            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) return true;
            return !parts.slice(1).includes(g.hostname);
          });

          if (g.ensure === "present") {
            const parts = [g.ip, g.hostname];
            if (g.aliases) parts.push(...g.aliases);
            filtered.push(parts.join("\t"));
          }

          let content = filtered.join("\n");
          if (!content.endsWith("\n")) content += "\n";
          await writeFileAs(client, "/etc/hosts", content, so);

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            hostname: g.hostname,
            ip: g.ip,
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
            hostname: g.hostname,
            ip: g.ip,
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

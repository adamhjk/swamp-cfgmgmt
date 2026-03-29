import { z } from "npm:zod@4";
import {
  exec,
  execSudo,
  getConnection,
  shellEscape,
  writeFile,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe("Unique identifier for this cron job"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether the cron job should be present or absent",
  ),
  command: z.string().describe("Command to run"),
  user: z.string().default("root").describe("User whose crontab to manage"),
  minute: z.string().default("*").describe("Minute (0-59 or *)"),
  hour: z.string().default("*").describe("Hour (0-23 or *)"),
  day: z.string().default("*").describe("Day of month (1-31 or *)"),
  month: z.string().default("*").describe("Month (1-12 or *)"),
  weekday: z.string().default("*").describe("Day of week (0-7 or *)"),
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
  name: z.string().describe("Cron job identifier"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    entryExists: z.boolean().describe("Whether the cron entry exists"),
    schedule: z.string().nullable().describe("Current schedule"),
    command: z.string().nullable().describe("Current command"),
  }).describe("Current cron state"),
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

const MARKER_PREFIX = "# cfgmgmt:";

async function gather(client, g) {
  const so = sudoOpts(g);
  const result = await execSudo(
    client,
    `crontab -l -u ${shellEscape(g.user)} 2>/dev/null`,
    so,
  );
  const lines = result.stdout.split("\n");
  const marker = `${MARKER_PREFIX}${g.name}`;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker && i + 1 < lines.length) {
      const cronLine = lines[i + 1].trim();
      const parts = cronLine.split(/\s+/);
      if (parts.length >= 6) {
        const schedule = parts.slice(0, 5).join(" ");
        const command = parts.slice(5).join(" ");
        return { entryExists: true, schedule, command };
      }
    }
  }
  return { entryExists: false, schedule: null, command: null };
}

function desiredSchedule(g) {
  return `${g.minute} ${g.hour} ${g.day} ${g.month} ${g.weekday}`;
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (!current.entryExists) {
      changes.push("add cron entry");
    } else {
      const sched = desiredSchedule(g);
      if (current.schedule !== sched) {
        changes.push(`schedule: ${current.schedule} -> ${sched}`);
      }
      if (current.command !== g.command) {
        changes.push(`command: ${current.command} -> ${g.command}`);
      }
    }
  } else {
    if (current.entryExists) changes.push("remove cron entry");
  }
  return changes;
}

function emptyCurrent() {
  return { entryExists: false, schedule: null, command: null };
}

export const model = {
  type: "@adam/cfgmgmt/cron",
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
      description: "Check if cron job matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            name: g.name,
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
            name: g.name,
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
      description: "Add, update, or remove a cron job",
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
          const marker = `${MARKER_PREFIX}${g.name}`;

          const existing = await execSudo(
            client,
            `crontab -l -u ${shellEscape(g.user)} 2>/dev/null`,
            so,
          );
          const lines = existing.stdout.split("\n");

          const filtered: string[] = [];
          let i = 0;
          while (i < lines.length) {
            if (lines[i].trim() === marker) {
              i += 2;
            } else {
              filtered.push(lines[i]);
              i++;
            }
          }

          while (
            filtered.length > 0 &&
            filtered[filtered.length - 1].trim() === ""
          ) {
            filtered.pop();
          }

          if (g.ensure === "present") {
            if (filtered.length > 0) filtered.push("");
            filtered.push(marker);
            filtered.push(
              `${desiredSchedule(g)} ${g.command}`,
            );
          }

          let content = filtered.join("\n");
          if (!content.endsWith("\n")) content += "\n";

          const tmpFile = `/tmp/.cfgmgmt-cron-${crypto.randomUUID()}`;
          await writeFile(client, tmpFile, content);
          const result = await execSudo(
            client,
            `crontab -u ${shellEscape(g.user)} ${tmpFile}`,
            so,
          );
          await exec(client, `rm -f ${tmpFile}`);
          if (result.exitCode !== 0) {
            throw new Error(`crontab load failed: ${result.stderr}`);
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            name: g.name,
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
            name: g.name,
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

import { z } from "npm:zod@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  timezone: z.string().describe(
    "Desired IANA timezone (e.g. America/New_York)",
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
  timezone: z.string().describe("Desired timezone"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    timezone: z.string().nullable().describe("Current timezone"),
    utcOffset: z.string().nullable().describe("Current UTC offset"),
  }).describe("Current timezone state on the remote node"),
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

  let tz: string | null = null;
  const timedatectl = await execSudo(
    client,
    `timedatectl show --property=Timezone --value 2>/dev/null`,
    so,
  );
  if (timedatectl.exitCode === 0 && timedatectl.stdout.trim()) {
    tz = timedatectl.stdout.trim();
  } else {
    const etcTz = await execSudo(
      client,
      `cat /etc/timezone 2>/dev/null`,
      so,
    );
    if (etcTz.exitCode === 0 && etcTz.stdout.trim()) {
      tz = etcTz.stdout.trim();
    } else {
      const link = await execSudo(
        client,
        `readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||'`,
        so,
      );
      if (link.exitCode === 0 && link.stdout.trim()) {
        tz = link.stdout.trim();
      }
    }
  }

  const offsetResult = await execSudo(client, `date +%z`, so);
  const utcOffset = offsetResult.stdout.trim() || null;

  return { timezone: tz, utcOffset };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (current.timezone !== g.timezone) {
    changes.push(`timezone: ${current.timezone} -> ${g.timezone}`);
  }
  return changes;
}

function emptyCurrent() {
  return { timezone: null, utcOffset: null };
}

export const model = {
  type: "@adam/cfgmgmt/timezone",
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
      description: "Check if timezone matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            timezone: g.timezone,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            timezone: g.timezone,
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
      description: "Set the system timezone to the desired value",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              timezone: g.timezone,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);

          const validate = await execSudo(
            client,
            `test -f /usr/share/zoneinfo/${shellEscape(g.timezone)}`,
            so,
          );
          if (validate.exitCode !== 0) {
            throw new Error(`Invalid timezone: ${g.timezone}`);
          }

          const timedatectlCheck = await execSudo(
            client,
            "command -v timedatectl",
            so,
          );
          if (timedatectlCheck.exitCode === 0) {
            const result = await execSudo(
              client,
              `timedatectl set-timezone ${shellEscape(g.timezone)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(
                `timedatectl set-timezone failed: ${result.stderr}`,
              );
            }
          } else {
            await execSudo(
              client,
              `ln -sf /usr/share/zoneinfo/${
                shellEscape(g.timezone)
              } /etc/localtime`,
              so,
            );
            await writeFileAs(client, "/etc/timezone", g.timezone + "\n", so);
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            timezone: g.timezone,
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            timezone: g.timezone,
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

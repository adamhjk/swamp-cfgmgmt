import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  mode: z.enum(["enforcing", "permissive", "disabled"]).optional().describe(
    "Desired SELinux mode (mutually exclusive with boolean)",
  ),
  boolean: z.string().optional().describe(
    "SELinux boolean name (mutually exclusive with mode)",
  ),
  booleanValue: z.enum(["on", "off"]).optional().describe(
    "Desired boolean value",
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
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    selinuxInstalled: z.boolean().describe("Whether SELinux is installed"),
    currentMode: z.string().nullable().describe("Current live SELinux mode"),
    configMode: z.string().nullable().describe(
      "Configured mode in /etc/selinux/config",
    ),
    booleanCurrent: z.string().nullable().describe("Current boolean value"),
  }).describe("Current SELinux state"),
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

  const cmdCheck = await execSudo(
    client,
    `command -v getenforce`,
    so,
  );
  const selinuxInstalled = cmdCheck.exitCode === 0;

  let currentMode: string | null = null;
  if (selinuxInstalled) {
    const getenforce = await execSudo(
      client,
      `getenforce 2>/dev/null`,
      so,
    );
    if (getenforce.exitCode === 0) {
      currentMode = getenforce.stdout.trim().toLowerCase();
    }
  }

  let configMode: string | null = null;
  if (selinuxInstalled) {
    const config = await execSudo(
      client,
      `grep '^SELINUX=' /etc/selinux/config 2>/dev/null | head -1`,
      so,
    );
    if (config.exitCode === 0 && config.stdout.trim()) {
      const match = config.stdout.match(/^SELINUX=(\S+)/);
      if (match) configMode = match[1].toLowerCase();
    }
  }

  let booleanCurrent: string | null = null;
  if (g.boolean && selinuxInstalled) {
    const result = await execSudo(
      client,
      `getsebool ${shellEscape(g.boolean)} 2>/dev/null`,
      so,
    );
    if (result.exitCode === 0) {
      const parts = result.stdout.trim().split(/\s+/);
      booleanCurrent = parts[parts.length - 1] || null;
    }
  }

  return { selinuxInstalled, currentMode, configMode, booleanCurrent };
}

function detectChanges(g, current) {
  const changes: string[] = [];

  if (g.mode !== undefined) {
    if (current.currentMode !== g.mode) {
      changes.push(`mode: ${current.currentMode} -> ${g.mode}`);
    }
    if (current.configMode !== g.mode) {
      changes.push(`config: ${current.configMode} -> ${g.mode}`);
    }
  }

  if (g.boolean !== undefined && g.booleanValue !== undefined) {
    if (current.booleanCurrent !== g.booleanValue) {
      changes.push(
        `boolean ${g.boolean}: ${current.booleanCurrent} -> ${g.booleanValue}`,
      );
    }
  }

  return changes;
}

function emptyCurrent() {
  return {
    selinuxInstalled: false,
    currentMode: null,
    configMode: null,
    booleanCurrent: null,
  };
}

export const model = {
  type: "@adam/cfgmgmt/selinux",
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
      description: "Check if SELinux matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          if (!g.mode && !g.boolean) {
            throw new Error("Either mode or boolean must be specified");
          }
          if (g.mode && g.boolean) {
            throw new Error("mode and boolean are mutually exclusive");
          }
          if (g.boolean && !g.booleanValue) {
            throw new Error("booleanValue is required when boolean is set");
          }

          const client = await connect(g);
          const current = await gather(client, g);

          if (!current.selinuxInstalled) {
            throw new Error("SELinux is not installed on this system");
          }

          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
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
      description: "Set SELinux mode or boolean value",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          if (!g.mode && !g.boolean) {
            throw new Error("Either mode or boolean must be specified");
          }
          if (g.mode && g.boolean) {
            throw new Error("mode and boolean are mutually exclusive");
          }
          if (g.boolean && !g.booleanValue) {
            throw new Error("booleanValue is required when boolean is set");
          }

          const client = await connect(g);
          const current = await gather(client, g);

          if (!current.selinuxInstalled) {
            throw new Error("SELinux is not installed on this system");
          }

          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);

          if (g.mode !== undefined) {
            if (
              current.currentMode !== g.mode &&
              g.mode !== "disabled" && current.currentMode !== "disabled"
            ) {
              const enforce = g.mode === "enforcing" ? "1" : "0";
              const result = await execSudo(
                client,
                `setenforce ${enforce}`,
                so,
              );
              if (result.exitCode !== 0) {
                throw new Error(`setenforce failed: ${result.stderr}`);
              }
            }

            if (current.configMode !== g.mode) {
              const result = await execSudo(
                client,
                `sed -i 's/^SELINUX=.*/SELINUX=${g.mode}/' /etc/selinux/config`,
                so,
              );
              if (result.exitCode !== 0) {
                throw new Error(
                  `Failed to update /etc/selinux/config: ${result.stderr}`,
                );
              }
            }

            if (
              (g.mode === "disabled" && current.currentMode !== "disabled") ||
              (g.mode !== "disabled" && current.currentMode === "disabled")
            ) {
              changes.push("reboot required for disabled<->enabled transition");
            }
          }

          if (g.boolean !== undefined && g.booleanValue !== undefined) {
            const result = await execSudo(
              client,
              `setsebool -P ${shellEscape(g.boolean)} ${g.booleanValue}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`setsebool failed: ${result.stderr}`);
            }
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
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

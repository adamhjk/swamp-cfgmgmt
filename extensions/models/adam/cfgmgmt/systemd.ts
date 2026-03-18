import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  service: z.string().describe("Service name (e.g. nginx or nginx.service)"),
  ensure: z.enum(["running", "stopped"]).optional().describe(
    "Whether service should be running or stopped",
  ),
  enabled: z.boolean().optional().describe(
    "Whether the service should be enabled at boot",
  ),
  unitFile: z.string().optional().describe(
    "Full content of a systemd unit file to deploy",
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
  service: z.string().describe("Service name"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    loaded: z.boolean().describe("Whether the unit is loaded"),
    active: z.string().describe("Active state (e.g. active, inactive, failed)"),
    enabled: z.string().describe("Unit file state (e.g. enabled, disabled)"),
  }).describe("Current service state"),
  changes: z.array(z.string()).describe("List of changes detected or applied"),
  error: z.string().nullable().describe("Error message if status is failed"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

const LogsSchema = z.object({
  service: z.string().describe("Service name"),
  output: z.string().describe("Journal log output"),
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

function unitFilePath(service) {
  return service.includes(".")
    ? `/etc/systemd/system/${service}`
    : `/etc/systemd/system/${service}.service`;
}

async function gather(client, service, g) {
  const result = await exec(
    client,
    wrapSudo(
      `systemctl show ${
        JSON.stringify(service)
      } --property=LoadState,ActiveState,UnitFileState --no-pager`,
      sudoOpts(g),
    ),
  );
  const props = new Map();
  for (const line of result.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      props.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
  }
  return {
    loaded: props.get("LoadState") === "loaded",
    active: props.get("ActiveState") || "unknown",
    enabled: props.get("UnitFileState") || "unknown",
  };
}

async function detectChanges(client, g, current) {
  const changes = [];

  if (g.unitFile !== undefined) {
    const path = unitFilePath(g.service);
    const result = await exec(
      client,
      wrapSudo(`cat ${JSON.stringify(path)} 2>/dev/null`, sudoOpts(g)),
    );
    if (result.exitCode !== 0) {
      changes.push("create unit file");
    } else if (result.stdout !== g.unitFile) {
      changes.push("update unit file");
    }
  }

  if (g.enabled !== undefined) {
    const isEnabled = current.enabled === "enabled";
    if (g.enabled && !isEnabled) changes.push("enable service");
    if (!g.enabled && isEnabled) changes.push("disable service");
  }

  if (g.ensure !== undefined) {
    const isActive = current.active === "active";
    if (g.ensure === "running" && !isActive) changes.push("start service");
    if (g.ensure === "stopped" && isActive) changes.push("stop service");
  }

  return changes;
}

function emptyCurrent() {
  return { loaded: false, active: "unknown", enabled: "unknown" };
}

export const model = {
  type: "@adam/cfgmgmt/systemd",
  version: "2026.03.02.1",
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
    logs: {
      description: "Journal log output for the service",
      schema: LogsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check if service matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.service, g);
          const changes = await detectChanges(client, g, current);

          const handle = await context.writeResource("state", g.nodeHost, {
            service: g.service,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            service: g.service,
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
      description: "Apply desired service state to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g.service, g);
          const changes = await detectChanges(client, g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              service: g.service,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const errors = [];

          const so = sudoOpts(g);
          if (
            changes.includes("create unit file") ||
            changes.includes("update unit file")
          ) {
            const path = unitFilePath(g.service);
            await writeFileAs(client, path, g.unitFile, so);
            const reload = await exec(
              client,
              wrapSudo("systemctl daemon-reload", so),
            );
            if (reload.exitCode !== 0) {
              errors.push(`daemon-reload: ${reload.stderr}`);
            }
          }

          if (changes.includes("enable service")) {
            const r = await exec(
              client,
              wrapSudo(`systemctl enable ${JSON.stringify(g.service)}`, so),
            );
            if (r.exitCode !== 0) errors.push(`enable: ${r.stderr}`);
          } else if (changes.includes("disable service")) {
            const r = await exec(
              client,
              wrapSudo(`systemctl disable ${JSON.stringify(g.service)}`, so),
            );
            if (r.exitCode !== 0) errors.push(`disable: ${r.stderr}`);
          }

          if (changes.includes("start service")) {
            const r = await exec(
              client,
              wrapSudo(`systemctl start ${JSON.stringify(g.service)}`, so),
            );
            if (r.exitCode !== 0) errors.push(`start: ${r.stderr}`);
          } else if (changes.includes("stop service")) {
            const r = await exec(
              client,
              wrapSudo(`systemctl stop ${JSON.stringify(g.service)}`, so),
            );
            if (r.exitCode !== 0) errors.push(`stop: ${r.stderr}`);
          }

          const updated = await gather(client, g.service, g);
          const failed = errors.length > 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            service: g.service,
            status: failed ? "failed" : "applied",
            current: updated,
            changes,
            error: failed ? errors.join("; ") : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(errors.join("; "));
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            service: g.service,
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
    restart: {
      description: "Restart the service (imperative, always runs)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const result = await exec(
            client,
            wrapSudo(
              `systemctl restart ${JSON.stringify(g.service)}`,
              sudoOpts(g),
            ),
          );
          const current = await gather(client, g.service, g);

          const failed = result.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            service: g.service,
            status: failed ? "failed" : "applied",
            current,
            changes: ["restart service"],
            error: failed ? result.stderr : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(result.stderr);
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            service: g.service,
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
    logs: {
      description: "Fetch recent journal logs for the service",
      arguments: z.object({
        lines: z.number().default(100).describe(
          "Number of journal lines to fetch",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const result = await exec(
            client,
            wrapSudo(
              `journalctl -u ${
                JSON.stringify(g.service)
              } --no-pager -n ${args.lines}`,
              sudoOpts(g),
            ),
          );

          const handle = await context.writeResource("logs", g.nodeHost, {
            service: g.service,
            output: result.stdout,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (_err) {
          const handle = await context.writeResource("logs", g.nodeHost, {
            service: g.service,
            output: "",
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
  },
};

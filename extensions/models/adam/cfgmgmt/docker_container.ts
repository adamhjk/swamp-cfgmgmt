import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe("Container name"),
  image: z.string().describe("Docker image (e.g. nginx:1.25)"),
  ensure: z.enum(["running", "stopped", "absent"]).describe(
    "Desired container state",
  ),
  ports: z.array(z.string()).optional().describe(
    'Port mappings (e.g. ["8080:80", "443:443"])',
  ),
  environment: z.array(z.string()).optional().describe(
    'Environment variables (e.g. ["FOO=bar"])',
  ),
  volumes: z.array(z.string()).optional().describe(
    'Volume mounts (e.g. ["/host:/container"])',
  ),
  restart: z.enum(["no", "always", "unless-stopped", "on-failure"]).optional()
    .describe("Restart policy"),
  command: z.string().optional().describe("Override container command"),
  network: z.string().optional().describe("Docker network to connect to"),
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
  name: z.string().describe("Container name"),
  ensure: z.string().describe("Desired state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    containerExists: z.boolean().describe("Whether the container exists"),
    containerStatus: z.string().nullable().describe(
      "Container status (running, exited, etc.)",
    ),
    imageId: z.string().nullable().describe("Current image ID"),
    currentImage: z.string().nullable().describe("Current image name"),
    ports: z.array(z.string()).describe("Current port mappings"),
    env: z.array(z.string()).meta({ sensitive: true }).describe(
      "Current environment variables",
    ),
    volumes: z.array(z.string()).describe("Current volume mounts"),
    restartPolicy: z.string().nullable().describe("Current restart policy"),
  }).describe("Current container state"),
  changes: z.array(z.string()).describe("List of changes detected or applied"),
  error: z.string().nullable().describe("Error message if status is failed"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

const LogsSchema = z.object({
  name: z.string().describe("Container name"),
  output: z.string().describe("Container log output"),
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

  const result = await execSudo(
    client,
    `docker inspect ${shellEscape(g.name)} 2>/dev/null`,
    so,
  );

  if (result.exitCode !== 0) {
    return {
      containerExists: false,
      containerStatus: null,
      imageId: null,
      currentImage: null,
      ports: [] as string[],
      env: [] as string[],
      volumes: [] as string[],
      restartPolicy: null,
    };
  }

  let info;
  try {
    const parsed = JSON.parse(result.stdout);
    info = parsed[0];
  } catch {
    return {
      containerExists: false,
      containerStatus: null,
      imageId: null,
      currentImage: null,
      ports: [] as string[],
      env: [] as string[],
      volumes: [] as string[],
      restartPolicy: null,
    };
  }

  const containerStatus = info.State?.Status || null;
  const imageId = info.Image || null;
  const currentImage = info.Config?.Image || null;

  const ports: string[] = [];
  const portBindings = info.HostConfig?.PortBindings || {};
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    const port = containerPort.replace("/tcp", "").replace("/udp", "");
    const proto = containerPort.includes("/udp") ? "/udp" : "";
    for (const binding of bindings as Array<{ HostPort: string }>) {
      ports.push(`${binding.HostPort}:${port}${proto}`);
    }
  }

  const allEnv: string[] = info.Config?.Env || [];
  const requestedKeys = new Set(
    (g.environment || []).map((e: string) => e.split("=")[0]),
  );
  const env = requestedKeys.size > 0
    ? allEnv.filter((e: string) => requestedKeys.has(e.split("=")[0]))
    : [];
  const volumes: string[] = [];
  const mounts = info.Mounts || [];
  for (const mount of mounts) {
    if (mount.Type === "bind") {
      volumes.push(`${mount.Source}:${mount.Destination}`);
    }
  }

  const restartPolicy = info.HostConfig?.RestartPolicy?.Name || null;

  return {
    containerExists: true,
    containerStatus,
    imageId,
    currentImage,
    ports: ports.sort(),
    env,
    volumes: volumes.sort(),
    restartPolicy,
  };
}

function detectChanges(g, current) {
  const changes: string[] = [];

  if (g.ensure === "absent") {
    if (current.containerExists) changes.push("remove container");
    return changes;
  }

  if (!current.containerExists) {
    changes.push("create container");
    if (g.ensure === "running") changes.push("start container");
    return changes;
  }

  let needRecreate = false;
  if (current.currentImage !== g.image) {
    changes.push(`image: ${current.currentImage} -> ${g.image}`);
    needRecreate = true;
  }

  if (g.ports !== undefined) {
    const desired = [...g.ports].sort();
    const have = [...current.ports].sort();
    if (JSON.stringify(desired) !== JSON.stringify(have)) {
      changes.push(`ports changed`);
      needRecreate = true;
    }
  }

  if (g.environment !== undefined) {
    for (const env of g.environment) {
      if (!current.env.includes(env)) {
        changes.push(`environment changed`);
        needRecreate = true;
        break;
      }
    }
  }

  if (g.volumes !== undefined) {
    const desired = [...g.volumes].sort();
    const have = [...current.volumes].sort();
    if (JSON.stringify(desired) !== JSON.stringify(have)) {
      changes.push(`volumes changed`);
      needRecreate = true;
    }
  }

  if (
    g.restart !== undefined && current.restartPolicy !== g.restart
  ) {
    changes.push(
      `restart: ${current.restartPolicy} -> ${g.restart}`,
    );
    needRecreate = true;
  }

  if (needRecreate) {
    if (!changes.includes("create container")) {
      changes.push("recreate container");
    }
  }

  if (g.ensure === "running" && current.containerStatus !== "running") {
    if (!needRecreate) changes.push("start container");
  }
  if (g.ensure === "stopped" && current.containerStatus === "running") {
    changes.push("stop container");
  }

  return changes;
}

function emptyCurrent() {
  return {
    containerExists: false,
    containerStatus: null,
    imageId: null,
    currentImage: null,
    ports: [] as string[],
    env: [] as string[],
    volumes: [] as string[],
    restartPolicy: null,
  };
}

function buildCreateCmd(g) {
  const args = ["docker", "create", "--name", shellEscape(g.name)];
  if (g.ports) {
    for (const p of g.ports) args.push("-p", shellEscape(p));
  }
  if (g.environment) {
    for (const e of g.environment) args.push("-e", shellEscape(e));
  }
  if (g.volumes) {
    for (const v of g.volumes) args.push("-v", shellEscape(v));
  }
  if (g.restart) args.push("--restart", shellEscape(g.restart));
  if (g.network) args.push("--network", shellEscape(g.network));
  args.push(shellEscape(g.image));
  if (g.command) args.push(shellEscape(g.command));
  return args.join(" ");
}

export const model = {
  type: "@adam/cfgmgmt/docker_container",
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
    logs: {
      description: "Container log output",
      schema: LogsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check if Docker container matches desired state (dry-run)",
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
      description: "Create, start, stop, or remove a Docker container",
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

          if (g.ensure === "absent") {
            if (current.containerExists) {
              await execSudo(
                client,
                `docker rm -f ${shellEscape(g.name)}`,
                so,
              );
            }
          } else if (changes.includes("recreate container")) {
            if (current.containerStatus === "running") {
              await execSudo(
                client,
                `docker stop ${shellEscape(g.name)}`,
                so,
              );
            }
            if (current.containerExists) {
              await execSudo(
                client,
                `docker rm ${shellEscape(g.name)}`,
                so,
              );
            }
            const createResult = await execSudo(
              client,
              buildCreateCmd(g),
              so,
            );
            if (createResult.exitCode !== 0) {
              throw new Error(`docker create failed: ${createResult.stderr}`);
            }
            if (g.ensure === "running") {
              const startResult = await execSudo(
                client,
                `docker start ${shellEscape(g.name)}`,
                so,
              );
              if (startResult.exitCode !== 0) {
                throw new Error(
                  `docker start failed: ${startResult.stderr}`,
                );
              }
            }
          } else if (changes.includes("create container")) {
            const createResult = await execSudo(
              client,
              buildCreateCmd(g),
              so,
            );
            if (createResult.exitCode !== 0) {
              throw new Error(`docker create failed: ${createResult.stderr}`);
            }
            if (changes.includes("start container")) {
              const startResult = await execSudo(
                client,
                `docker start ${shellEscape(g.name)}`,
                so,
              );
              if (startResult.exitCode !== 0) {
                throw new Error(
                  `docker start failed: ${startResult.stderr}`,
                );
              }
            }
          } else if (changes.includes("start container")) {
            const result = await execSudo(
              client,
              `docker start ${shellEscape(g.name)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`docker start failed: ${result.stderr}`);
            }
          } else if (changes.includes("stop container")) {
            const result = await execSudo(
              client,
              `docker stop ${shellEscape(g.name)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`docker stop failed: ${result.stderr}`);
            }
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
    logs: {
      description: "Fetch recent container logs",
      arguments: z.object({
        lines: z.number().default(100).describe(
          "Number of log lines to fetch",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const result = await execSudo(
            client,
            `docker logs --tail ${args.lines} ${shellEscape(g.name)} 2>&1`,
            sudoOpts(g),
          );
          const handle = await context.writeResource("logs", g.nodeHost, {
            name: g.name,
            output: result.stdout,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (_err) {
          const handle = await context.writeResource("logs", g.nodeHost, {
            name: g.name,
            output: "",
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
    restart: {
      description: "Restart the container (imperative, always runs)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const result = await execSudo(
            client,
            `docker restart ${shellEscape(g.name)}`,
            sudoOpts(g),
          );
          const current = await gather(client, g);
          const failed = result.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            name: g.name,
            ensure: g.ensure,
            status: failed ? "failed" : "applied",
            current,
            changes: ["restart container"],
            error: failed ? result.stderr : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(result.stderr);
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

import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  packages: z.array(z.string()).default([]).describe("Package names to manage"),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether packages should be present or absent",
  ),
  version: z.string().optional().describe(
    "Pin to a specific package version (e.g. 1.24.0-1ubuntu1). Applies to all packages in the list.",
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
  packages: z.array(z.object({
    name: z.string().describe("Package name"),
    installed: z.boolean().describe("Whether the package is installed"),
    version: z.string().nullable().describe("Installed version"),
  })).nullable().describe("Per-package status"),
  changes: z.array(z.string()).describe("List of changes (e.g. install nginx)"),
  stdout: z.string().describe("Command output"),
  stderr: z.string().describe("Command error output"),
  error: z.string().nullable().describe("Error message if status is failed"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

const InstalledSchema = z.object({
  packages: z.array(z.object({
    name: z.string().describe("Package name"),
    version: z.string().describe("Installed version"),
  })).describe("All installed packages"),
  count: z.number().describe("Total number of installed packages"),
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

async function queryPackages(client, packages, g) {
  const so = sudoOpts(g);
  const results = [];
  for (const pkg of packages) {
    const r = await execSudo(
      client,
      `dpkg-query -W -f '\${Status} \${Version}' ${
        shellEscape(pkg)
      } 2>/dev/null`,
      so,
    );
    if (r.exitCode === 0 && r.stdout.includes("install ok installed")) {
      const version = r.stdout.trim().split(/\s+/).pop() || null;
      results.push({ name: pkg, installed: true, version });
    } else {
      results.push({ name: pkg, installed: false, version: null });
    }
  }
  return results;
}

function detectChanges(packages, ensure, version) {
  const changes = [];
  for (const pkg of packages) {
    if (ensure === "present" && !pkg.installed) {
      changes.push(`install ${pkg.name}${version ? `=${version}` : ""}`);
    } else if (ensure === "present" && pkg.installed && version) {
      if (pkg.version !== version) {
        changes.push(
          `upgrade ${pkg.name} from ${pkg.version} to ${version}`,
        );
      }
    } else if (ensure === "absent" && pkg.installed) {
      changes.push(`remove ${pkg.name}`);
    }
  }
  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/apt",
  version: "2026.03.18.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({
    packages: z.array(z.string()).optional().describe(
      "Package names to manage",
    ),
    ensure: z.enum(["present", "absent"]).optional().describe(
      "Whether packages should be present or absent",
    ),
    version: z.string().optional().describe(
      "Pin to a specific package version",
    ),
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
      description: "Package operation state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    installed: {
      description: "All installed packages",
      schema: InstalledSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check if packages match desired state without modifying",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const packages = await queryPackages(client, g.packages, g);
          const changes = detectChanges(packages, g.ensure, g.version);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: changes.length === 0 ? "compliant" : "non_compliant",
            packages,
            changes,
            stdout: "",
            stderr: "",
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    apply: {
      description: "Install or remove packages based on ensure state",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const packages = await queryPackages(client, g.packages, g);
          const changes = detectChanges(packages, g.ensure, g.version);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              status: "compliant",
              packages,
              changes: [],
              stdout: "",
              stderr: "",
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const toInstall = packages.filter((p) =>
            g.ensure === "present" &&
            (!p.installed || (g.version && p.version !== g.version))
          ).map((p) => g.version ? `${p.name}=${g.version}` : p.name);
          const toRemove = packages.filter((p) =>
            g.ensure === "absent" && p.installed
          ).map((p) => p.name);

          let stdout = "";
          let stderr = "";

          const so = sudoOpts(g);
          if (toInstall.length > 0) {
            const r = await execSudo(
              client,
              `DEBIAN_FRONTEND=noninteractive apt-get install -y ${
                toInstall.map(shellEscape).join(" ")
              }`,
              so,
            );
            stdout += r.stdout;
            stderr += r.stderr;
            if (r.exitCode !== 0) {
              const errorMsg =
                `apt-get install failed with exit code ${r.exitCode}`;
              await context.writeResource("state", g.nodeHost, {
                status: "failed",
                packages: await queryPackages(client, g.packages, g),
                changes,
                stdout,
                stderr,
                error: errorMsg,
                timestamp: new Date().toISOString(),
              });
              throw new Error(errorMsg);
            }
          }

          if (toRemove.length > 0) {
            const r = await execSudo(
              client,
              `DEBIAN_FRONTEND=noninteractive apt-get remove -y ${
                toRemove.map(shellEscape).join(" ")
              }`,
              so,
            );
            stdout += r.stdout;
            stderr += r.stderr;
            if (r.exitCode !== 0) {
              const errorMsg =
                `apt-get remove failed with exit code ${r.exitCode}`;
              await context.writeResource("state", g.nodeHost, {
                status: "failed",
                packages: await queryPackages(client, g.packages, g),
                changes,
                stdout,
                stderr,
                error: errorMsg,
                timestamp: new Date().toISOString(),
              });
              throw new Error(errorMsg);
            }
          }

          const updated = await queryPackages(client, g.packages, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "applied",
            packages: updated,
            changes,
            stdout,
            stderr,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    refresh: {
      description: "Update the apt package database",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await execSudo(client, "apt-get update", sudoOpts(g));
          const failed = r.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            status: failed ? "failed" : "applied",
            packages: null,
            changes: failed ? [] : ["database updated"],
            stdout: r.stdout,
            stderr: r.stderr,
            error: failed
              ? `apt-get update failed with exit code ${r.exitCode}`
              : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) {
            throw new Error(
              `apt-get update failed with exit code ${r.exitCode}`,
            );
          }
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    upgrade: {
      description: "Upgrade all installed packages",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await execSudo(
            client,
            "DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
            sudoOpts(g),
          );
          const failed = r.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            status: failed ? "failed" : "applied",
            packages: null,
            changes: failed ? [] : ["system upgraded"],
            stdout: r.stdout,
            stderr: r.stderr,
            error: failed
              ? `apt-get upgrade failed with exit code ${r.exitCode}`
              : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) {
            throw new Error(
              `apt-get upgrade failed with exit code ${r.exitCode}`,
            );
          }
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    list: {
      description: "List all installed packages",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await execSudo(
            client,
            "dpkg-query -W -f '${Package} ${Version}\\n'",
            sudoOpts(g),
          );
          if (r.exitCode !== 0) {
            const errorMsg = `dpkg-query failed with exit code ${r.exitCode}`;
            await context.writeResource("state", g.nodeHost, {
              status: "failed",
              packages: null,
              changes: [],
              stdout: r.stdout,
              stderr: r.stderr,
              error: errorMsg,
              timestamp: new Date().toISOString(),
            });
            throw new Error(errorMsg);
          }

          const packages = r.stdout.trim().split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const parts = line.split(/\s+/);
              return { name: parts[0], version: parts[1] || "unknown" };
            });

          const handle = await context.writeResource("installed", g.nodeHost, {
            packages,
            count: packages.length,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
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

import { z } from "npm:zod@4";
import { exec, getConnection } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  hostname: z.string().describe("Hostname or IP of the remote node"),
  sshUser: z.string().default("root").describe("SSH username"),
  sshPort: z.number().default(22).describe("SSH port"),
  sshIdentityFile: z.string().optional().describe("Path to SSH private key"),
});

const InfoSchema = z.object({
  hostname: z.string().describe("System hostname"),
  os: z.string().describe("OS identifier (e.g. fedora, ubuntu, arch)"),
  osVersion: z.string().describe("OS version (e.g. 41, 24.04)"),
  arch: z.string().describe("CPU architecture (e.g. x86_64, aarch64)"),
  kernel: z.string().describe("Kernel version"),
  packageManagers: z.array(z.string()).describe("Detected package managers"),
  gatheredAt: z.string().describe(
    "ISO 8601 timestamp of when facts were gathered",
  ),
});

export const model = {
  type: "@adam/cfgmgmt/node",
  version: "2026.03.02.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({
    hostname: z.string().optional().describe(
      "Hostname or IP of the remote node",
    ),
    sshUser: z.string().optional().describe("SSH username"),
    sshPort: z.number().optional().describe("SSH port"),
    sshIdentityFile: z.string().optional().describe("Path to SSH private key"),
  }),
  resources: {
    info: {
      description: "Facts gathered from the node",
      schema: InfoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    gather: {
      description: "SSH to node and gather system facts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const client = await getConnection({
          host: g.hostname,
          port: g.sshPort,
          username: g.sshUser,
          privateKeyPath: g.sshIdentityFile,
        });

        const unameResult = await exec(client, "uname -srm");
        const unameParts = unameResult.stdout.trim().split(/\s+/);
        const kernel = unameParts[1] || unameParts[0] || "unknown";
        const arch = unameParts[2] || "unknown";

        const osReleaseResult = await exec(
          client,
          "cat /etc/os-release 2>/dev/null || echo 'ID=unknown'",
        );
        const osRelease = new Map<string, string>();
        for (const line of osReleaseResult.stdout.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) {
            const key = line.slice(0, eq);
            const val = line.slice(eq + 1).replace(/^"|"$/g, "");
            osRelease.set(key, val);
          }
        }

        const hostnameResult = await exec(client, "hostname");

        const probes = [
          ["pacman", "pacman"],
          ["apt", "apt-get"],
          ["dnf", "dnf"],
          ["yum", "yum"],
          ["homebrew", "brew"],
          ["nix", "nix-env"],
          ["zypper", "zypper"],
          ["apk", "apk"],
        ];
        const packageManagers = [];
        for (const [name, bin] of probes) {
          const r = await exec(client, `command -v ${bin} 2>/dev/null`);
          if (r.exitCode === 0) packageManagers.push(name);
        }

        const handle = await context.writeResource("info", g.hostname, {
          hostname: hostnameResult.stdout.trim(),
          os: osRelease.get("ID") || "unknown",
          osVersion: osRelease.get("VERSION_ID") || "unknown",
          arch,
          kernel,
          packageManagers,
          gatheredAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};

import { z } from "npm:zod@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe(
    "Repository identifier used for the .list/.sources filename (e.g. docker, nodesource)",
  ),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether the repository should be present or absent",
  ),
  uris: z.array(z.string()).optional().describe(
    "Repository URIs (e.g. ['https://download.docker.com/linux/ubuntu']). For DEB822 format.",
  ),
  suites: z.array(z.string()).optional().describe(
    "Repository suites (e.g. ['noble']). For DEB822 format.",
  ),
  components: z.array(z.string()).optional().describe(
    "Repository components (e.g. ['stable']). For DEB822 format.",
  ),
  architectures: z.array(z.string()).optional().describe(
    "Architectures to enable (e.g. ['amd64']). For DEB822 format.",
  ),
  signedBy: z.string().optional().describe(
    "Path to the GPG keyring file on the remote node (e.g. /usr/share/keyrings/docker.gpg)",
  ),
  gpgKeyUrl: z.string().optional().describe(
    "URL to download the GPG key from. Will be dearmored and saved to signedBy path.",
  ),
  sourceLine: z.string().optional().describe(
    "Legacy one-line format: 'deb [options] uri suite component...' — written to /etc/apt/sources.list.d/<name>.list. Mutually exclusive with uris/suites/components.",
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
  name: z.string().describe("Repository name"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    repoFileExists: z.boolean().describe("Whether the repo source file exists"),
    gpgKeyExists: z.boolean().describe("Whether the GPG key file exists"),
    repoContent: z.string().nullable().describe("Current repo file content"),
  }).describe("Current repository state"),
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

function emptyCurrent() {
  return { repoFileExists: false, gpgKeyExists: false, repoContent: null };
}

function repoFilePath(g) {
  if (g.sourceLine) {
    return `/etc/apt/sources.list.d/${g.name}.list`;
  }
  return `/etc/apt/sources.list.d/${g.name}.sources`;
}

function buildDeb822Content(g) {
  const lines = ["Types: deb"];
  if (g.uris) lines.push(`URIs: ${g.uris.join(" ")}`);
  if (g.suites) lines.push(`Suites: ${g.suites.join(" ")}`);
  if (g.components) lines.push(`Components: ${g.components.join(" ")}`);
  if (g.architectures) {
    lines.push(`Architectures: ${g.architectures.join(" ")}`);
  }
  if (g.signedBy) lines.push(`Signed-By: ${g.signedBy}`);
  return lines.join("\n") + "\n";
}

function desiredContent(g) {
  if (g.sourceLine) return g.sourceLine.trim() + "\n";
  return buildDeb822Content(g);
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const path = repoFilePath(g);

  const repoResult = await execSudo(
    client,
    `cat ${shellEscape(path)} 2>/dev/null`,
    so,
  );
  const repoFileExists = repoResult.exitCode === 0;
  const repoContent = repoFileExists ? repoResult.stdout : null;

  let gpgKeyExists = false;
  if (g.signedBy) {
    const keyResult = await execSudo(
      client,
      `test -f ${shellEscape(g.signedBy)} && echo Y || echo N`,
      so,
    );
    gpgKeyExists = keyResult.stdout.trim() === "Y";
  }

  return { repoFileExists, gpgKeyExists, repoContent };
}

function detectChanges(g, current) {
  const changes = [];

  if (g.ensure === "present") {
    if (g.gpgKeyUrl && g.signedBy && !current.gpgKeyExists) {
      changes.push("download GPG key");
    }
    if (!current.repoFileExists) {
      changes.push("create repository file");
    } else {
      const desired = desiredContent(g);
      if (current.repoContent !== desired) {
        changes.push("update repository file");
      }
    }
  } else {
    if (current.repoFileExists) {
      changes.push("remove repository file");
    }
    if (g.signedBy && current.gpgKeyExists) {
      changes.push("remove GPG key");
    }
  }

  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/apt_repository",
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
      description:
        "Check if the apt repository is configured as desired (dry-run)",
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
      description: "Configure or remove an apt repository on the remote node",
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

          if (g.ensure === "present") {
            // Download GPG key if needed
            if (changes.includes("download GPG key")) {
              const keyDir = g.signedBy.substring(
                0,
                g.signedBy.lastIndexOf("/"),
              );
              if (keyDir) {
                await execSudo(
                  client,
                  `mkdir -p ${shellEscape(keyDir)}`,
                  so,
                );
              }

              // Try curl, fallback to wget. Dearmor if needed.
              const curlCheck = await execSudo(
                client,
                "command -v curl",
                so,
              );
              const fetchCmd = curlCheck.exitCode === 0
                ? `curl -fsSL ${shellEscape(g.gpgKeyUrl)}`
                : `wget -qO- ${shellEscape(g.gpgKeyUrl)}`;

              const dlResult = await execSudo(
                client,
                `${fetchCmd} | gpg --dearmor -o ${shellEscape(g.signedBy)}`,
                so,
              );
              if (dlResult.exitCode !== 0) {
                // Try without dearmor (key may already be binary)
                const dlResult2 = await execSudo(
                  client,
                  `${fetchCmd} > ${shellEscape(g.signedBy)}`,
                  so,
                );
                if (dlResult2.exitCode !== 0) {
                  throw new Error(
                    `Failed to download GPG key: ${dlResult2.stderr}`,
                  );
                }
              }
            }

            // Write repo file
            const path = repoFilePath(g);
            const content = desiredContent(g);
            await writeFileAs(client, path, content, so);
          } else {
            // Remove repo file and GPG key
            const path = repoFilePath(g);
            if (current.repoFileExists) {
              await execSudo(
                client,
                `rm -f ${shellEscape(path)}`,
                so,
              );
            }
            if (g.signedBy && current.gpgKeyExists) {
              await execSudo(
                client,
                `rm -f ${shellEscape(g.signedBy)}`,
                so,
              );
            }
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

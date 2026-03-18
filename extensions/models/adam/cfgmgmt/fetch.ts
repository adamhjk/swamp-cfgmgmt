import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  url: z.string().describe("URL to download"),
  path: z.string().describe(
    "Absolute path where the downloaded file should be placed on the remote node",
  ),
  checksum: z.string().optional().describe(
    "Expected checksum of the file (e.g. sha256:abc123...). Used for idempotency.",
  ),
  checksumType: z.enum(["sha256", "sha1", "md5"]).default("sha256").describe(
    "Checksum algorithm to use",
  ),
  owner: z.string().optional().describe("File owner"),
  group: z.string().optional().describe("File group"),
  mode: z.string().optional().describe("File permissions in octal (e.g. 0755)"),
  force: z.boolean().default(false).describe(
    "Re-download even if the file already exists and checksum matches",
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
  url: z.string().describe("Source URL"),
  path: z.string().describe("Destination path"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    fileExists: z.boolean().describe("Whether the file exists"),
    checksum: z.string().nullable().describe("Current file checksum"),
    owner: z.string().nullable().describe("Current file owner"),
    group: z.string().nullable().describe("Current file group"),
    mode: z.string().nullable().describe("Current file mode"),
  }).describe("Current file state on the remote node"),
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
  return {
    fileExists: false,
    checksum: null,
    owner: null,
    group: null,
    mode: null,
  };
}

function checksumCmd(type) {
  switch (type) {
    case "sha256":
      return "sha256sum";
    case "sha1":
      return "sha1sum";
    case "md5":
      return "md5sum";
    default:
      return "sha256sum";
  }
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const statResult = await exec(
    client,
    wrapSudo(
      `stat -c '%U|%G|%a' ${
        JSON.stringify(g.path)
      } 2>/dev/null || echo 'NOTFOUND'`,
      so,
    ),
  );
  const line = statResult.stdout.trim();
  if (line === "NOTFOUND") {
    return emptyCurrent();
  }

  const parts = line.split("|");
  if (parts.length < 3) {
    return emptyCurrent();
  }
  const [owner, group, mode] = parts;
  let checksum = null;
  const cmd = checksumCmd(g.checksumType);
  const hashResult = await exec(
    client,
    wrapSudo(
      `${cmd} ${JSON.stringify(g.path)} 2>/dev/null | awk '{print $1}'`,
      so,
    ),
  );
  if (hashResult.exitCode === 0 && hashResult.stdout.trim()) {
    checksum = hashResult.stdout.trim();
  }

  return {
    fileExists: true,
    checksum,
    owner,
    group,
    mode: `0${mode}`,
  };
}

function detectChanges(g, current) {
  const changes = [];

  if (g.force) {
    changes.push("download (forced)");
    return changes;
  }

  if (!current.fileExists) {
    changes.push("download file");
  } else if (g.checksum && current.checksum !== g.checksum) {
    changes.push(`checksum mismatch: ${current.checksum} != ${g.checksum}`);
  }

  if (current.fileExists) {
    if (g.owner && current.owner !== g.owner) {
      changes.push(`owner: ${current.owner} -> ${g.owner}`);
    }
    if (g.group && current.group !== g.group) {
      changes.push(`group: ${current.group} -> ${g.group}`);
    }
    if (g.mode && current.mode !== g.mode) {
      changes.push(`mode: ${current.mode} -> ${g.mode}`);
    }
  }

  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/fetch",
  version: "2026.03.04.1",
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
  },
  methods: {
    check: {
      description:
        "Check if the file has been downloaded and matches expected state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            url: g.url,
            path: g.path,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            url: g.url,
            path: g.path,
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
      description: "Download a file from a URL to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              url: g.url,
              path: g.path,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);
          const needsDownload = changes.some((c) =>
            c.includes("download") || c.includes("checksum mismatch")
          );

          if (needsDownload) {
            const dir = g.path.substring(0, g.path.lastIndexOf("/"));
            if (dir) {
              await exec(
                client,
                wrapSudo(`mkdir -p ${JSON.stringify(dir)}`, so),
              );
            }

            // Try curl first, fall back to wget
            const curlCheck = await exec(
              client,
              wrapSudo("command -v curl", so),
            );
            let downloadCmd;
            if (curlCheck.exitCode === 0) {
              downloadCmd = `curl -fsSL -o ${JSON.stringify(g.path)} ${
                JSON.stringify(g.url)
              }`;
            } else {
              downloadCmd = `wget -q -O ${JSON.stringify(g.path)} ${
                JSON.stringify(g.url)
              }`;
            }

            const dlResult = await exec(
              client,
              wrapSudo(downloadCmd, so),
            );
            if (dlResult.exitCode !== 0) {
              throw new Error(
                `Download failed: ${dlResult.stderr || dlResult.stdout}`,
              );
            }

            // Verify checksum after download
            if (g.checksum) {
              const cmd = checksumCmd(g.checksumType);
              const hashResult = await exec(
                client,
                wrapSudo(
                  `${cmd} ${JSON.stringify(g.path)} | awk '{print $1}'`,
                  so,
                ),
              );
              const actualChecksum = hashResult.stdout.trim();
              if (actualChecksum !== g.checksum) {
                await exec(
                  client,
                  wrapSudo(`rm -f ${JSON.stringify(g.path)}`, so),
                );
                throw new Error(
                  `Checksum verification failed: expected ${g.checksum}, got ${actualChecksum}`,
                );
              }
            }
          }

          // Set ownership and permissions
          if (g.owner || g.group) {
            const ownership = g.group ? `${g.owner || ""}:${g.group}` : g.owner;
            await exec(
              client,
              wrapSudo(
                `chown ${JSON.stringify(ownership)} ${JSON.stringify(g.path)}`,
                so,
              ),
            );
          }
          if (g.mode) {
            await exec(
              client,
              wrapSudo(`chmod ${g.mode} ${JSON.stringify(g.path)}`, so),
            );
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            url: g.url,
            path: g.path,
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            url: g.url,
            path: g.path,
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
};

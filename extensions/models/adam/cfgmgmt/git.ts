import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Local path for the repository"),
  repo: z.string().describe("Git repository URL"),
  revision: z.string().default("HEAD").describe(
    "Branch, tag, or commit hash (default HEAD = default branch)",
  ),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether the repository should be present or absent",
  ),
  depth: z.number().optional().describe("Shallow clone depth"),
  owner: z.string().optional().describe("Repository owner"),
  group: z.string().optional().describe("Repository group"),
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
  path: z.string().describe("Repository path"),
  repo: z.string().describe("Repository URL"),
  ensure: z.string().describe("Desired state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the path exists"),
    isGitRepo: z.boolean().describe("Whether the path is a git repository"),
    currentCommit: z.string().nullable().describe("Current HEAD commit hash"),
    currentBranch: z.string().nullable().describe(
      "Current branch (null if detached)",
    ),
    originUrl: z.string().nullable().describe("Current origin remote URL"),
    owner: z.string().nullable().describe("Current directory owner"),
    group: z.string().nullable().describe("Current directory group"),
  }).describe("Current git repository state"),
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

function isCommitHash(rev: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(rev);
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const existsResult = await exec(
    client,
    wrapSudo(`test -d ${JSON.stringify(g.path)} && echo Y || echo N`, so),
  );
  const exists = existsResult.stdout.trim() === "Y";
  if (!exists) {
    return {
      exists: false,
      isGitRepo: false,
      currentCommit: null,
      currentBranch: null,
      originUrl: null,
      owner: null,
      group: null,
    };
  }

  const gitCheck = await exec(
    client,
    wrapSudo(
      `test -d ${JSON.stringify(g.path + "/.git")} && echo Y || echo N`,
      so,
    ),
  );
  const isGitRepo = gitCheck.stdout.trim() === "Y";

  if (!isGitRepo) {
    const stat = await exec(
      client,
      wrapSudo(
        `stat -c '%U|%G' ${JSON.stringify(g.path)} 2>/dev/null`,
        so,
      ),
    );
    const parts1 = stat.stdout.trim().split("|");
    return {
      exists: true,
      isGitRepo: false,
      currentCommit: null,
      currentBranch: null,
      originUrl: null,
      owner: parts1.length >= 2 ? parts1[0] || null : null,
      group: parts1.length >= 2 ? parts1[1] || null : null,
    };
  }

  const commit = await exec(
    client,
    wrapSudo(`git -C ${JSON.stringify(g.path)} rev-parse HEAD 2>/dev/null`, so),
  );
  const branch = await exec(
    client,
    wrapSudo(
      `git -C ${JSON.stringify(g.path)} symbolic-ref --short HEAD 2>/dev/null`,
      so,
    ),
  );
  const origin = await exec(
    client,
    wrapSudo(
      `git -C ${JSON.stringify(g.path)} remote get-url origin 2>/dev/null`,
      so,
    ),
  );
  const stat = await exec(
    client,
    wrapSudo(
      `stat -c '%U|%G' ${JSON.stringify(g.path)} 2>/dev/null`,
      so,
    ),
  );
  const parts2 = stat.stdout.trim().split("|");

  return {
    exists: true,
    isGitRepo: true,
    currentCommit: commit.exitCode === 0 ? commit.stdout.trim() : null,
    currentBranch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    originUrl: origin.exitCode === 0 ? origin.stdout.trim() : null,
    owner: parts2.length >= 2 ? parts2[0] || null : null,
    group: parts2.length >= 2 ? parts2[1] || null : null,
  };
}

function detectChanges(g, current) {
  const changes: string[] = [];

  if (g.ensure === "absent") {
    if (current.exists) changes.push("remove repository");
    return changes;
  }

  if (!current.exists) {
    changes.push("clone repository");
    return changes;
  }

  if (current.exists && !current.isGitRepo) {
    changes.push("path exists but is not a git repository");
    return changes;
  }

  if (current.originUrl !== g.repo) {
    changes.push(`origin: ${current.originUrl} -> ${g.repo}`);
  }

  if (g.revision !== "HEAD") {
    if (isCommitHash(g.revision)) {
      if (
        current.currentCommit &&
        !current.currentCommit.startsWith(g.revision)
      ) {
        changes.push(`commit: ${current.currentCommit} -> ${g.revision}`);
      }
    } else {
      if (current.currentBranch !== g.revision) {
        changes.push(
          `branch: ${current.currentBranch || "detached"} -> ${g.revision}`,
        );
      }
    }
  }

  if (g.owner && current.owner !== g.owner) {
    changes.push(`owner: ${current.owner} -> ${g.owner}`);
  }
  if (g.group && current.group !== g.group) {
    changes.push(`group: ${current.group} -> ${g.group}`);
  }

  return changes;
}

function emptyCurrent() {
  return {
    exists: false,
    isGitRepo: false,
    currentCommit: null,
    currentBranch: null,
    originUrl: null,
    owner: null,
    group: null,
  };
}

export const model = {
  type: "@adam/cfgmgmt/git",
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
      description: "Check if git repository matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const isError = changes.some((c) =>
            c.includes("not a git repository")
          );
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            repo: g.repo,
            ensure: g.ensure,
            status: isError
              ? "failed"
              : changes.length === 0
              ? "compliant"
              : "non_compliant",
            current,
            changes,
            error: isError ? "Path exists but is not a git repository" : null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
            repo: g.repo,
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
      description: "Clone, update, or remove a git repository",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (
            changes.some((c) => c.includes("not a git repository"))
          ) {
            throw new Error(
              `Path ${g.path} exists but is not a git repository`,
            );
          }

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              path: g.path,
              repo: g.repo,
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
            await exec(
              client,
              wrapSudo(`rm -rf ${JSON.stringify(g.path)}`, so),
            );
          } else if (changes.includes("clone repository")) {
            const args = ["git", "clone"];
            if (g.depth) args.push("--depth", String(g.depth));
            if (
              g.revision !== "HEAD" && !isCommitHash(g.revision)
            ) {
              args.push("--branch", g.revision);
            }
            args.push(JSON.stringify(g.repo), JSON.stringify(g.path));
            const result = await exec(
              client,
              wrapSudo(args.join(" "), so),
            );
            if (result.exitCode !== 0) {
              throw new Error(`git clone failed: ${result.stderr}`);
            }

            if (isCommitHash(g.revision)) {
              if (g.depth) {
                await exec(
                  client,
                  wrapSudo(
                    `git -C ${JSON.stringify(g.path)} fetch --unshallow`,
                    so,
                  ),
                );
              }
              const checkout = await exec(
                client,
                wrapSudo(
                  `git -C ${JSON.stringify(g.path)} checkout ${g.revision}`,
                  so,
                ),
              );
              if (checkout.exitCode !== 0) {
                throw new Error(
                  `git checkout failed: ${checkout.stderr}`,
                );
              }
            }
          } else {
            if (changes.some((c) => c.startsWith("origin:"))) {
              await exec(
                client,
                wrapSudo(
                  `git -C ${JSON.stringify(g.path)} remote set-url origin ${
                    JSON.stringify(g.repo)
                  }`,
                  so,
                ),
              );
            }

            if (
              changes.some((c) =>
                c.startsWith("branch:") || c.startsWith("commit:")
              )
            ) {
              await exec(
                client,
                wrapSudo(
                  `git -C ${JSON.stringify(g.path)} fetch origin`,
                  so,
                ),
              );

              if (isCommitHash(g.revision)) {
                await exec(
                  client,
                  wrapSudo(
                    `git -C ${JSON.stringify(g.path)} checkout ${g.revision}`,
                    so,
                  ),
                );
              } else {
                const checkout = await exec(
                  client,
                  wrapSudo(
                    `git -C ${JSON.stringify(g.path)} checkout ${g.revision}`,
                    so,
                  ),
                );
                if (checkout.exitCode !== 0) {
                  throw new Error(
                    `git checkout failed: ${checkout.stderr}`,
                  );
                }
                await exec(
                  client,
                  wrapSudo(
                    `git -C ${
                      JSON.stringify(g.path)
                    } pull origin ${g.revision}`,
                    so,
                  ),
                );
              }
            }
          }

          if (
            g.ensure === "present" && (g.owner || g.group)
          ) {
            const ownership = g.group ? `${g.owner || ""}:${g.group}` : g.owner;
            await exec(
              client,
              wrapSudo(
                `chown -R ${JSON.stringify(ownership)} ${
                  JSON.stringify(g.path)
                }`,
                so,
              ),
            );
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            repo: g.repo,
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
            path: g.path,
            repo: g.repo,
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

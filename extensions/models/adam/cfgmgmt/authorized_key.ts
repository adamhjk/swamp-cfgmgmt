import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  user: z.string().describe("User whose authorized_keys file to manage"),
  key: z.string().describe("Full SSH public key line"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether the key should be present or absent",
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
  user: z.string().describe("Target user"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    fileExists: z.boolean().describe(
      "Whether authorized_keys file exists",
    ),
    keyPresent: z.boolean().describe("Whether the key is in the file"),
    authorizedKeysPath: z.string().nullable().describe(
      "Path to the authorized_keys file",
    ),
  }).describe("Current authorized key state"),
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

function keyBody(key: string): string {
  const parts = key.trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : key.trim();
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const homeResult = await exec(
    client,
    wrapSudo(
      `getent passwd ${JSON.stringify(g.user)} | cut -d: -f6`,
      so,
    ),
  );
  const home = homeResult.stdout.trim();
  if (!home) {
    throw new Error(`User ${g.user} not found`);
  }

  const akPath = `${home}/.ssh/authorized_keys`;
  const catResult = await exec(
    client,
    wrapSudo(`cat ${JSON.stringify(akPath)} 2>/dev/null`, so),
  );
  const fileExists = catResult.exitCode === 0;
  const body = keyBody(g.key);
  const keyPresent = fileExists &&
    catResult.stdout.split("\n").some((line) => line.includes(body));

  return { fileExists, keyPresent, authorizedKeysPath: akPath };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present" && !current.keyPresent) {
    changes.push("add key");
  }
  if (g.ensure === "absent" && current.keyPresent) {
    changes.push("remove key");
  }
  return changes;
}

function emptyCurrent() {
  return { fileExists: false, keyPresent: false, authorizedKeysPath: null };
}

export const model = {
  type: "@adam/cfgmgmt/authorized_key",
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
      description:
        "Check if SSH authorized key matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            user: g.user,
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
            user: g.user,
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
      description:
        "Add or remove an SSH public key from a user's authorized_keys",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              user: g.user,
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
          const akPath = current.authorizedKeysPath!;
          const sshDir = akPath.substring(0, akPath.lastIndexOf("/"));

          if (g.ensure === "present") {
            await exec(
              client,
              wrapSudo(
                `mkdir -p ${JSON.stringify(sshDir)} && chmod 700 ${
                  JSON.stringify(sshDir)
                }`,
                so,
              ),
            );
            let content = "";
            if (current.fileExists) {
              const existing = await exec(
                client,
                wrapSudo(`cat ${JSON.stringify(akPath)}`, so),
              );
              content = existing.stdout;
              if (content && !content.endsWith("\n")) content += "\n";
            }
            content += g.key.trim() + "\n";
            await writeFileAs(client, akPath, content, so);
            await exec(
              client,
              wrapSudo(`chmod 600 ${JSON.stringify(akPath)}`, so),
            );
            await exec(
              client,
              wrapSudo(
                `chown ${JSON.stringify(g.user + ":" + g.user)} ${
                  JSON.stringify(sshDir)
                } ${JSON.stringify(akPath)}`,
                so,
              ),
            );
          } else {
            const body = keyBody(g.key);
            const existing = await exec(
              client,
              wrapSudo(`cat ${JSON.stringify(akPath)}`, so),
            );
            const filtered = existing.stdout.split("\n")
              .filter((line) => !line.includes(body))
              .join("\n");
            await writeFileAs(client, akPath, filtered, so);
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            user: g.user,
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
            user: g.user,
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

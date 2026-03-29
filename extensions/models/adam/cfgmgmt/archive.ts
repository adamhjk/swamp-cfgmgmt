import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  source: z.string().describe("Path to the archive file on the remote node"),
  dest: z.string().describe("Extraction destination directory"),
  format: z.enum(["auto", "tar", "tar.gz", "tar.bz2", "tar.xz", "zip"])
    .default("auto").describe(
      "Archive format (auto-detected from extension by default)",
    ),
  creates: z.string().optional().describe(
    "Idempotency guard: skip extraction if this path exists",
  ),
  owner: z.string().optional().describe("Owner for extracted files"),
  group: z.string().optional().describe("Group for extracted files"),
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
  source: z.string().describe("Archive source path"),
  dest: z.string().describe("Extraction destination"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    sourceExists: z.boolean().describe("Whether the source archive exists"),
    destExists: z.boolean().describe(
      "Whether the destination directory exists",
    ),
    createsExists: z.boolean().describe(
      "Whether the creates guard path exists",
    ),
  }).describe("Current archive state"),
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
  const sourceResult = await execSudo(
    client,
    `test -f ${shellEscape(g.source)} && echo Y || echo N`,
    so,
  );
  const destResult = await execSudo(
    client,
    `test -d ${shellEscape(g.dest)} && echo Y || echo N`,
    so,
  );

  let createsExists = false;
  if (g.creates) {
    const createsResult = await execSudo(
      client,
      `test -e ${shellEscape(g.creates)} && echo Y || echo N`,
      so,
    );
    createsExists = createsResult.stdout.trim() === "Y";
  }

  return {
    sourceExists: sourceResult.stdout.trim() === "Y",
    destExists: destResult.stdout.trim() === "Y",
    createsExists,
  };
}

function detectFormat(source: string, explicit: string): string {
  if (explicit !== "auto") return explicit;
  if (source.endsWith(".tar.gz") || source.endsWith(".tgz")) return "tar.gz";
  if (source.endsWith(".tar.bz2") || source.endsWith(".tbz2")) return "tar.bz2";
  if (source.endsWith(".tar.xz") || source.endsWith(".txz")) return "tar.xz";
  if (source.endsWith(".tar")) return "tar";
  if (source.endsWith(".zip")) return "zip";
  return "tar.gz";
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (!current.sourceExists) {
    changes.push("source archive not found");
    return changes;
  }
  if (g.creates && current.createsExists) return changes;
  if (!g.creates && current.destExists) return changes;
  changes.push("extract archive");
  return changes;
}

function emptyCurrent() {
  return { sourceExists: false, destExists: false, createsExists: false };
}

export const model = {
  type: "@adam/cfgmgmt/archive",
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
      description: "Check if archive has been extracted (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const isError = changes.some((c) => c.includes("not found"));
          const handle = await context.writeResource("state", g.nodeHost, {
            source: g.source,
            dest: g.dest,
            status: isError
              ? "failed"
              : changes.length === 0
              ? "compliant"
              : "non_compliant",
            current,
            changes,
            error: isError ? "Source archive not found" : null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            source: g.source,
            dest: g.dest,
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
      description: "Extract an archive to the destination directory",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.some((c) => c.includes("not found"))) {
            throw new Error(`Source archive not found: ${g.source}`);
          }

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              source: g.source,
              dest: g.dest,
              status: "compliant",
              current,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const so = sudoOpts(g);
          const format = detectFormat(g.source, g.format);

          await execSudo(
            client,
            `mkdir -p ${shellEscape(g.dest)}`,
            so,
          );

          let extractCmd: string;
          const src = shellEscape(g.source);
          const dst = shellEscape(g.dest);
          switch (format) {
            case "tar":
              extractCmd = `tar -xf ${src} -C ${dst}`;
              break;
            case "tar.gz":
              extractCmd = `tar -xzf ${src} -C ${dst}`;
              break;
            case "tar.bz2":
              extractCmd = `tar -xjf ${src} -C ${dst}`;
              break;
            case "tar.xz":
              extractCmd = `tar -xJf ${src} -C ${dst}`;
              break;
            case "zip": {
              const unzipCheck = await execSudo(
                client,
                `command -v unzip`,
                so,
              );
              if (unzipCheck.exitCode !== 0) {
                throw new Error("unzip is not installed");
              }
              extractCmd = `unzip -o ${src} -d ${dst}`;
              break;
            }
            default:
              extractCmd = `tar -xzf ${src} -C ${dst}`;
          }

          const result = await execSudo(client, extractCmd, so);
          if (result.exitCode !== 0) {
            throw new Error(`Extraction failed: ${result.stderr}`);
          }

          if (g.owner || g.group) {
            const ownership = g.group ? `${g.owner || ""}:${g.group}` : g.owner;
            await execSudo(
              client,
              `chown -R ${shellEscape(ownership)} ${dst}`,
              so,
            );
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            source: g.source,
            dest: g.dest,
            status: "applied",
            current: updated,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            source: g.source,
            dest: g.dest,
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

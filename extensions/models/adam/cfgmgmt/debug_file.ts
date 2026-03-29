import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path of the file to read on the remote node",
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
  path: z.string().describe("Path of the file that was read"),
  exists: z.boolean().describe("Whether the file exists on the remote node"),
  content: z.string().describe(
    "File content (empty string if file does not exist)",
  ),
  size: z.number().describe("File size in bytes (0 if file does not exist)"),
  error: z.string().nullable().describe(
    "Error message if connection failed or file could not be read",
  ),
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

export const model = {
  type: "@adam/cfgmgmt/debug_file",
  version: "2026.03.27.1",
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
      description: "Content fetched from a remote file",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description:
        "Fetch the file content from the remote host and store it as data",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const result = await execSudo(
            client,
            `cat ${shellEscape(g.path)}`,
            so,
          );
          if (result.exitCode !== 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              path: g.path,
              exists: false,
              content: "",
              size: 0,
              error: result.stderr.trim() ||
                "File not found or not readable",
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
          const sizeResult = await execSudo(
            client,
            `stat -c '%s' ${shellEscape(g.path)}`,
            so,
          );
          const size = parseInt(sizeResult.stdout.trim(), 10) || 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            exists: true,
            content: result.stdout,
            size,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
            exists: false,
            content: "",
            size: 0,
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

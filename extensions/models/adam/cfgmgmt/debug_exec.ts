import { z } from "npm:zod@4";
import { execSudo, getConnection } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  command: z.string().describe("The command to execute on the remote host"),
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
  command: z.string().describe("The command that was executed"),
  stdout: z.string().describe("Standard output from the command"),
  stderr: z.string().describe("Standard error from the command"),
  exitCode: z.number().describe("Exit code of the command"),
  error: z.string().nullable().describe(
    "Error message if connection failed",
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
  type: "@adam/cfgmgmt/debug_exec",
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
      description: "Output captured from remote command execution",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description:
        "Execute the command on the remote host and capture output as data",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const result = await execSudo(client, g.command, sudoOpts(g));
          const handle = await context.writeResource("state", g.nodeHost, {
            command: g.command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            command: g.command,
            stdout: "",
            stderr: "",
            exitCode: -1,
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

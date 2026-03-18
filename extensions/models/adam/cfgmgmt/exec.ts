import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  command: z.string().describe("The command to execute"),
  onlyIf: z.string().optional().describe(
    "Guard: only run if this command exits 0",
  ),
  notIf: z.string().optional().describe("Guard: skip if this command exits 0"),
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
  command: z.string().describe("The command that was or would be executed"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  stdout: z.string().describe("Standard output from the command"),
  stderr: z.string().describe("Standard error from the command"),
  exitCode: z.number().describe("Exit code of the command"),
  changes: z.array(z.string()).describe("List of changes"),
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

async function shouldRun(
  client,
  g,
): Promise<{ run: boolean; reason: string | null }> {
  const so = sudoOpts(g);
  if (g.onlyIf !== undefined) {
    const r = await exec(client, wrapSudo(g.onlyIf, so));
    if (r.exitCode !== 0) {
      return { run: false, reason: `onlyIf command exited ${r.exitCode}` };
    }
  }
  if (g.notIf !== undefined) {
    const r = await exec(client, wrapSudo(g.notIf, so));
    if (r.exitCode === 0) {
      return { run: false, reason: `notIf command exited 0` };
    }
  }
  return { run: true, reason: null };
}

export const model = {
  type: "@adam/cfgmgmt/exec",
  version: "2026.03.02.1",
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
      description: "Result of command execution",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Dry-run: validate SSH connectivity without executing the command",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const guard = await shouldRun(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            command: g.command,
            status: guard.run ? "non_compliant" : "compliant",
            stdout: "",
            stderr: "",
            exitCode: 0,
            changes: guard.run ? [`exec: ${g.command}`] : [],
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            command: g.command,
            status: "failed",
            stdout: "",
            stderr: "",
            exitCode: 1,
            changes: [],
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    apply: {
      description: "Execute the command on the remote node via SSH",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const guard = await shouldRun(client, g);
          if (!guard.run) {
            const handle = await context.writeResource("state", g.nodeHost, {
              command: g.command,
              status: "compliant",
              stdout: "",
              stderr: "",
              exitCode: 0,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
          const result = await exec(client, wrapSudo(g.command, sudoOpts(g)));
          const failed = result.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            command: g.command,
            status: failed ? "failed" : "applied",
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            changes: [`exec: ${g.command}`],
            error: failed ? result.stderr : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(result.stderr);
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            command: g.command,
            status: "failed",
            stdout: "",
            stderr: "",
            exitCode: 1,
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

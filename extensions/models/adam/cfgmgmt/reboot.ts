import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  timeout: z.number().default(300).describe(
    "Maximum seconds to wait for the host to come back after reboot",
  ),
  message: z.string().default("Rebooting via cfgmgmt").describe(
    "Broadcast message before reboot",
  ),
  testCommand: z.string().default("uptime").describe(
    "Command to run after reconnection to verify the host is healthy",
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
  preRebootUptime: z.string().nullable().describe(
    "System uptime before reboot",
  ),
  postRebootUptime: z.string().nullable().describe(
    "System uptime after reboot",
  ),
  changes: z.array(z.string()).describe("List of changes applied"),
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
    preRebootUptime: null,
    postRebootUptime: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSsh(g, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const interval = 5000;

  while (Date.now() < deadline) {
    try {
      const args = [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-p",
        String(g.nodePort),
      ];
      if (g.nodeIdentityFile) args.push("-i", g.nodeIdentityFile);
      args.push(`${g.nodeUser}@${g.nodeHost}`, "echo ready");

      const cmd = new Deno.Command("ssh", {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (output.code === 0) {
        const stdout = new TextDecoder().decode(output.stdout);
        if (stdout.trim() === "ready") return true;
      }
    } catch {
      // Host not ready yet
    }
    await sleep(interval);
  }
  return false;
}

export const model = {
  type: "@adam/cfgmgmt/reboot",
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
      description: "Result of the reboot operation",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Check is always non-compliant — reboot is an imperative action",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const uptimeResult = await exec(
            client,
            wrapSudo("uptime -s 2>/dev/null || uptime", sudoOpts(g)),
          );
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "non_compliant",
            preRebootUptime: uptimeResult.stdout.trim(),
            postRebootUptime: null,
            changes: ["reboot required"],
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            ...emptyCurrent(),
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
        "Reboot the remote host and wait for SSH to become available again",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const so = sudoOpts(g);

          // Record pre-reboot uptime
          const uptimeResult = await exec(
            client,
            wrapSudo("uptime -s 2>/dev/null || uptime", so),
          );
          const preRebootUptime = uptimeResult.stdout.trim();

          // Trigger reboot — use nohup + sleep to give SSH time to return
          const msg = JSON.stringify(g.message);
          await exec(
            client,
            wrapSudo(
              `nohup sh -c 'sleep 1 && shutdown -r now ${msg}' >/dev/null 2>&1 &`,
              so,
            ),
          );

          // Wait for the host to go down
          await sleep(5000);

          // Wait for SSH to come back
          const came_back = await waitForSsh(g, g.timeout);
          if (!came_back) {
            throw new Error(
              `Host ${g.nodeHost} did not come back within ${g.timeout} seconds`,
            );
          }

          // Re-establish connection (old ControlMaster is dead)
          const newClient = await getConnection({
            host: g.nodeHost,
            port: g.nodePort,
            username: g.nodeUser,
            privateKeyPath: g.nodeIdentityFile,
          });

          // Run test command and get new uptime
          const testResult = await exec(
            newClient,
            wrapSudo(g.testCommand, so),
          );
          if (testResult.exitCode !== 0) {
            throw new Error(
              `Post-reboot test command failed: ${testResult.stderr}`,
            );
          }

          const newUptime = await exec(
            newClient,
            wrapSudo("uptime -s 2>/dev/null || uptime", so),
          );

          const handle = await context.writeResource("state", g.nodeHost, {
            status: "applied",
            preRebootUptime,
            postRebootUptime: newUptime.stdout.trim(),
            changes: ["rebooted host"],
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            status: "failed",
            ...emptyCurrent(),
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

import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe("Kernel module name (e.g. br_netfilter, overlay)"),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether the module should be loaded or unloaded",
  ),
  params: z.string().optional().describe(
    "Module parameters (e.g. 'option1=value1 option2=value2')",
  ),
  persist: z.boolean().default(true).describe(
    "Persist the module across reboots via /etc/modules-load.d/",
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
  name: z.string().describe("Module name"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    loaded: z.boolean().describe("Whether the module is currently loaded"),
    persisted: z.boolean().describe(
      "Whether a persistence file exists in /etc/modules-load.d/",
    ),
  }).describe("Current kernel module state"),
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
  return { loaded: false, persisted: false };
}

function persistPath(name) {
  return `/etc/modules-load.d/cfgmgmt-${name}.conf`;
}

async function gather(client, g) {
  const so = sudoOpts(g);

  const lsmodResult = await exec(
    client,
    wrapSudo(
      `lsmod | grep -qw ${JSON.stringify(g.name)} && echo Y || echo N`,
      so,
    ),
  );
  const loaded = lsmodResult.stdout.trim() === "Y";

  const path = persistPath(g.name);
  const fileResult = await exec(
    client,
    wrapSudo(`test -f ${JSON.stringify(path)} && echo Y || echo N`, so),
  );
  const persisted = fileResult.stdout.trim() === "Y";

  return { loaded, persisted };
}

function detectChanges(g, current) {
  const changes = [];

  if (g.ensure === "present") {
    if (!current.loaded) changes.push("load module");
    if (g.persist && !current.persisted) {
      changes.push("create persistence file");
    }
  } else {
    if (current.loaded) changes.push("unload module");
    if (current.persisted) changes.push("remove persistence file");
  }

  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/kernel_module",
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
        "Check if the kernel module is loaded/persisted as desired (dry-run)",
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
      description: "Load or unload a kernel module and manage persistence",
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
            if (changes.includes("load module")) {
              const params = g.params || "";
              const r = await exec(
                client,
                wrapSudo(`modprobe ${JSON.stringify(g.name)} ${params}`, so),
              );
              if (r.exitCode !== 0) {
                throw new Error(`modprobe failed: ${r.stderr}`);
              }
            }
            if (changes.includes("create persistence file")) {
              const path = persistPath(g.name);
              await writeFileAs(client, path, `${g.name}\n`, so);
            }
          } else {
            if (changes.includes("unload module")) {
              const r = await exec(
                client,
                wrapSudo(`rmmod ${JSON.stringify(g.name)}`, so),
              );
              if (r.exitCode !== 0) {
                throw new Error(`rmmod failed: ${r.stderr}`);
              }
            }
            if (changes.includes("remove persistence file")) {
              const path = persistPath(g.name);
              await exec(
                client,
                wrapSudo(`rm -f ${JSON.stringify(path)}`, so),
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
};

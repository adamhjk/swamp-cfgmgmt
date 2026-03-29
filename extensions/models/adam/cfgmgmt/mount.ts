import { z } from "npm:zod@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Mount point path"),
  device: z.string().describe("Device or remote filesystem to mount"),
  fstype: z.string().describe("Filesystem type (e.g. ext4, nfs, tmpfs)"),
  options: z.string().default("defaults").describe(
    "Mount options (e.g. defaults,noatime)",
  ),
  ensure: z.enum(["mounted", "unmounted", "present", "absent"]).describe(
    "Desired mount state: mounted=fstab+mounted, unmounted=fstab+not mounted, present=fstab only, absent=remove fstab+unmount",
  ),
  dump: z.number().default(0).describe("fstab dump field"),
  pass: z.number().default(0).describe("fstab pass field"),
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
  path: z.string().describe("Mount point path"),
  ensure: z.string().describe("Desired mount state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    mounted: z.boolean().describe("Whether currently mounted"),
    mountDevice: z.string().nullable().describe("Device of active mount"),
    mountFstype: z.string().nullable().describe(
      "Filesystem type of active mount",
    ),
    mountOptions: z.string().nullable().describe("Options of active mount"),
    fstabPresent: z.boolean().describe("Whether entry exists in fstab"),
    fstabDevice: z.string().nullable().describe("Device in fstab"),
    fstabFstype: z.string().nullable().describe("Filesystem type in fstab"),
    fstabOptions: z.string().nullable().describe("Options in fstab"),
  }).describe("Current mount state"),
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

  const findmnt = await execSudo(
    client,
    `findmnt -n -o SOURCE,FSTYPE,OPTIONS --target ${
      shellEscape(g.path)
    } 2>/dev/null`,
    so,
  );
  let mounted = false;
  let mountDevice: string | null = null;
  let mountFstype: string | null = null;
  let mountOptions: string | null = null;

  if (findmnt.exitCode === 0 && findmnt.stdout.trim()) {
    const parts = findmnt.stdout.trim().split(/\s+/);
    if (parts.length >= 3) {
      const mountTarget = await execSudo(
        client,
        `findmnt -n -o TARGET --target ${shellEscape(g.path)} 2>/dev/null`,
        so,
      );
      if (mountTarget.stdout.trim() === g.path) {
        mounted = true;
        mountDevice = parts[0];
        mountFstype = parts[1];
        mountOptions = parts.slice(2).join(" ");
      }
    }
  }

  const fstabResult = await execSudo(
    client,
    `cat /etc/fstab 2>/dev/null`,
    so,
  );
  let fstabPresent = false;
  let fstabDevice: string | null = null;
  let fstabFstype: string | null = null;
  let fstabOptions: string | null = null;

  for (const line of fstabResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 4 && parts[1] === g.path) {
      fstabPresent = true;
      fstabDevice = parts[0];
      fstabFstype = parts[2];
      fstabOptions = parts[3];
      break;
    }
  }

  return {
    mounted,
    mountDevice,
    mountFstype,
    mountOptions,
    fstabPresent,
    fstabDevice,
    fstabFstype,
    fstabOptions,
  };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  const needFstab = g.ensure !== "absent";
  const needMounted = g.ensure === "mounted";
  const needUnmounted = g.ensure === "unmounted" || g.ensure === "absent";

  if (needFstab) {
    if (!current.fstabPresent) {
      changes.push("add fstab entry");
    } else {
      if (current.fstabDevice !== g.device) {
        changes.push(`fstab device: ${current.fstabDevice} -> ${g.device}`);
      }
      if (current.fstabFstype !== g.fstype) {
        changes.push(`fstab fstype: ${current.fstabFstype} -> ${g.fstype}`);
      }
      if (current.fstabOptions !== g.options) {
        changes.push(`fstab options: ${current.fstabOptions} -> ${g.options}`);
      }
    }
  }

  if (g.ensure === "absent" && current.fstabPresent) {
    changes.push("remove fstab entry");
  }

  if (needMounted && !current.mounted) {
    changes.push("mount filesystem");
  }
  if (needUnmounted && current.mounted) {
    changes.push("unmount filesystem");
  }

  return changes;
}

function emptyCurrent() {
  return {
    mounted: false,
    mountDevice: null,
    mountFstype: null,
    mountOptions: null,
    fstabPresent: false,
    fstabDevice: null,
    fstabFstype: null,
    fstabOptions: null,
  };
}

export const model = {
  type: "@adam/cfgmgmt/mount",
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
      description: "Check if mount matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
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
            path: g.path,
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
      description: "Manage filesystem mount and fstab entry",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              path: g.path,
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
          const needFstab = g.ensure !== "absent";

          if (
            changes.includes("unmount filesystem")
          ) {
            const result = await execSudo(
              client,
              `umount ${shellEscape(g.path)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`umount failed: ${result.stderr}`);
            }
          }

          const fstabChanges = changes.some((c) => c.includes("fstab"));
          if (fstabChanges) {
            const fstabResult = await execSudo(
              client,
              `cat /etc/fstab`,
              so,
            );
            const lines = fstabResult.stdout.split("\n");
            const filtered = lines.filter((line) => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) return true;
              const parts = trimmed.split(/\s+/);
              return !(parts.length >= 2 && parts[1] === g.path);
            });

            if (needFstab) {
              filtered.push(
                `${g.device}\t${g.path}\t${g.fstype}\t${g.options}\t${g.dump}\t${g.pass}`,
              );
            }

            let content = filtered.join("\n");
            if (!content.endsWith("\n")) content += "\n";
            await writeFileAs(client, "/etc/fstab", content, so);
          }

          if (changes.includes("mount filesystem")) {
            await execSudo(
              client,
              `mkdir -p ${shellEscape(g.path)}`,
              so,
            );
            const result = await execSudo(
              client,
              `mount ${shellEscape(g.path)}`,
              so,
            );
            if (result.exitCode !== 0) {
              throw new Error(`mount failed: ${result.stderr}`);
            }
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
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

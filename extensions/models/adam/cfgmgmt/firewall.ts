import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  port: z.number().describe("Port number"),
  protocol: z.enum(["tcp", "udp"]).default("tcp").describe(
    "Protocol (tcp or udp)",
  ),
  action: z.enum(["allow", "deny", "reject"]).describe(
    "Firewall action for the rule",
  ),
  direction: z.enum(["in", "out"]).default("in").describe(
    "Traffic direction",
  ),
  source: z.string().optional().describe("Source CIDR (e.g. 10.0.0.0/8)"),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether the rule should be present or absent",
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
  port: z.number().describe("Port number"),
  protocol: z.string().describe("Protocol"),
  action: z.string().describe("Firewall action"),
  ensure: z.string().describe("Desired state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    backend: z.string().nullable().describe(
      "Detected firewall backend (ufw, firewalld, iptables)",
    ),
    ruleExists: z.boolean().describe("Whether the rule currently exists"),
    ruleDetails: z.string().nullable().describe("Details of the matched rule"),
  }).describe("Current firewall state"),
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

async function detectBackend(client, g) {
  const so = sudoOpts(g);
  const ufw = await exec(
    client,
    wrapSudo(`ufw status 2>/dev/null | head -1`, so),
  );
  if (ufw.exitCode === 0 && ufw.stdout.includes("active")) return "ufw";

  const firewalld = await exec(
    client,
    wrapSudo(`firewall-cmd --state 2>/dev/null`, so),
  );
  if (firewalld.exitCode === 0 && firewalld.stdout.trim() === "running") {
    return "firewalld";
  }

  const iptables = await exec(
    client,
    wrapSudo(`command -v iptables 2>/dev/null`, so),
  );
  if (iptables.exitCode === 0) return "iptables";

  return null;
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const backend = await detectBackend(client, g);
  if (!backend) {
    return { backend: null, ruleExists: false, ruleDetails: null };
  }

  let ruleExists = false;
  let ruleDetails: string | null = null;

  if (backend === "ufw") {
    const result = await exec(
      client,
      wrapSudo(`ufw status`, so),
    );
    const pattern = `${g.port}/${g.protocol}`;
    for (const line of result.stdout.split("\n")) {
      if (line.includes(pattern)) {
        if (g.source) {
          if (line.includes(g.source)) {
            ruleExists = true;
            ruleDetails = line.trim();
            break;
          }
        } else {
          ruleExists = true;
          ruleDetails = line.trim();
          break;
        }
      }
    }
  } else if (backend === "firewalld") {
    if (g.source) {
      const result = await exec(
        client,
        wrapSudo(`firewall-cmd --list-rich-rules 2>/dev/null`, so),
      );
      const portStr = `port port="${g.port}" protocol="${g.protocol}"`;
      for (const line of result.stdout.split("\n")) {
        if (line.includes(portStr) && line.includes(g.source)) {
          ruleExists = true;
          ruleDetails = line.trim();
          break;
        }
      }
    } else {
      const result = await exec(
        client,
        wrapSudo(`firewall-cmd --list-ports 2>/dev/null`, so),
      );
      const pattern = `${g.port}/${g.protocol}`;
      if (result.stdout.split(/\s+/).includes(pattern)) {
        ruleExists = true;
        ruleDetails = pattern;
      }
    }
  } else if (backend === "iptables") {
    const chain = g.direction === "in" ? "INPUT" : "OUTPUT";
    const result = await exec(
      client,
      wrapSudo(`iptables -L ${chain} -n 2>/dev/null`, so),
    );
    for (const line of result.stdout.split("\n")) {
      if (line.includes(`dpt:${g.port}`) && line.includes(g.protocol)) {
        if (g.source) {
          if (line.includes(g.source)) {
            ruleExists = true;
            ruleDetails = line.trim();
            break;
          }
        } else {
          ruleExists = true;
          ruleDetails = line.trim();
          break;
        }
      }
    }
  }

  return { backend, ruleExists, ruleDetails };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (!current.backend) {
    changes.push("no firewall backend detected");
    return changes;
  }
  if (g.ensure === "present" && !current.ruleExists) {
    changes.push(`add ${g.action} rule for ${g.port}/${g.protocol}`);
  }
  if (g.ensure === "absent" && current.ruleExists) {
    changes.push(`remove rule for ${g.port}/${g.protocol}`);
  }
  return changes;
}

function emptyCurrent() {
  return { backend: null, ruleExists: false, ruleDetails: null };
}

export const model = {
  type: "@adam/cfgmgmt/firewall",
  version: "2026.03.03.1",
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
      description: "Check if firewall rule matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const status = !current.backend
            ? "failed" as const
            : changes.length === 0
            ? "compliant" as const
            : "non_compliant" as const;
          const handle = await context.writeResource("state", g.nodeHost, {
            port: g.port,
            protocol: g.protocol,
            action: g.action,
            ensure: g.ensure,
            status,
            current,
            changes,
            error: !current.backend
              ? "No firewall backend found (ufw, firewalld, iptables)"
              : null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            port: g.port,
            protocol: g.protocol,
            action: g.action,
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
      description: "Add or remove a firewall rule",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (!current.backend) {
            throw new Error(
              "No firewall backend found (ufw, firewalld, iptables)",
            );
          }

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              port: g.port,
              protocol: g.protocol,
              action: g.action,
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
          const errors: string[] = [];

          if (current.backend === "ufw") {
            if (g.ensure === "present") {
              let cmd: string;
              if (g.source) {
                cmd =
                  `ufw ${g.action} from ${g.source} to any port ${g.port} proto ${g.protocol}`;
              } else {
                cmd = `ufw ${g.action} ${g.port}/${g.protocol}`;
              }
              const r = await exec(client, wrapSudo(cmd, so));
              if (r.exitCode !== 0) errors.push(r.stderr);
            } else {
              let cmd: string;
              if (g.source) {
                cmd =
                  `ufw delete ${g.action} from ${g.source} to any port ${g.port} proto ${g.protocol}`;
              } else {
                cmd = `ufw delete ${g.action} ${g.port}/${g.protocol}`;
              }
              const r = await exec(client, wrapSudo(cmd, so));
              if (r.exitCode !== 0) errors.push(r.stderr);
            }
          } else if (current.backend === "firewalld") {
            const actionMap = {
              allow: "accept",
              deny: "drop",
              reject: "reject",
            };
            if (g.source) {
              const fwAction = actionMap[g.action];
              const rule =
                `rule family="ipv4" source address="${g.source}" port port="${g.port}" protocol="${g.protocol}" ${fwAction}`;
              const flag = g.ensure === "present"
                ? "--add-rich-rule"
                : "--remove-rich-rule";
              const r = await exec(
                client,
                wrapSudo(
                  `firewall-cmd --permanent ${flag}='${rule}' && firewall-cmd --reload`,
                  so,
                ),
              );
              if (r.exitCode !== 0) errors.push(r.stderr);
            } else {
              const flag = g.ensure === "present"
                ? "--add-port"
                : "--remove-port";
              const r = await exec(
                client,
                wrapSudo(
                  `firewall-cmd --permanent ${flag}=${g.port}/${g.protocol} && firewall-cmd --reload`,
                  so,
                ),
              );
              if (r.exitCode !== 0) errors.push(r.stderr);
            }
          } else if (current.backend === "iptables") {
            const chain = g.direction === "in" ? "INPUT" : "OUTPUT";
            const target = { allow: "ACCEPT", deny: "DROP", reject: "REJECT" }[
              g.action
            ];
            const flag = g.ensure === "present" ? "-A" : "-D";
            let cmd =
              `iptables ${flag} ${chain} -p ${g.protocol} --dport ${g.port}`;
            if (g.source) cmd += ` -s ${g.source}`;
            cmd += ` -j ${target}`;
            const r = await exec(client, wrapSudo(cmd, so));
            if (r.exitCode !== 0) errors.push(r.stderr);
          }

          if (errors.length > 0) {
            throw new Error(errors.join("; "));
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            port: g.port,
            protocol: g.protocol,
            action: g.action,
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
            port: g.port,
            protocol: g.protocol,
            action: g.action,
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
};

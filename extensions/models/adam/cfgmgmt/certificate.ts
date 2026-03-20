import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  name: z.string().describe(
    "Certificate name — used as a label in state output",
  ),
  certContent: z.string().describe("PEM-encoded certificate content"),
  keyContent: z.string().meta({ sensitive: true }).describe(
    "PEM-encoded private key content",
  ),
  chainContent: z.string().optional().describe(
    "PEM-encoded certificate chain (intermediate + root CAs)",
  ),
  certPath: z.string().describe(
    "Absolute path for the certificate file on the remote node",
  ),
  keyPath: z.string().describe(
    "Absolute path for the private key file on the remote node",
  ),
  chainPath: z.string().optional().describe(
    "Absolute path for the chain file on the remote node",
  ),
  owner: z.string().optional().describe(
    "Owner for all certificate files",
  ),
  group: z.string().optional().describe(
    "Group for all certificate files",
  ),
  certMode: z.string().default("0644").describe(
    "Permissions for the certificate file",
  ),
  keyMode: z.string().default("0600").describe(
    "Permissions for the private key file (default: restricted)",
  ),
  chainMode: z.string().default("0644").describe(
    "Permissions for the chain file",
  ),
  validate: z.boolean().default(true).describe(
    "Validate that the certificate and key match using openssl",
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
  name: z.string().describe("Certificate name"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    certExists: z.boolean().describe("Whether the cert file exists"),
    keyExists: z.boolean().describe("Whether the key file exists"),
    chainExists: z.boolean().describe("Whether the chain file exists"),
    certSha256: z.string().nullable().describe("SHA-256 of current cert file"),
    keySha256: z.string().nullable().describe("SHA-256 of current key file"),
    chainSha256: z.string().nullable().describe(
      "SHA-256 of current chain file",
    ),
    certKeyMatch: z.boolean().nullable().describe(
      "Whether cert and key modulus match",
    ),
  }).describe("Current certificate state on the remote node"),
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
  return {
    certExists: false,
    keyExists: false,
    chainExists: false,
    certSha256: null,
    keySha256: null,
    chainSha256: null,
    certKeyMatch: null,
  };
}

async function hashContent(content) {
  const data = new TextEncoder().encode(content);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function fileHash(client, path, so) {
  const r = await exec(
    client,
    wrapSudo(
      `sha256sum ${JSON.stringify(path)} 2>/dev/null | awk '{print $1}'`,
      so,
    ),
  );
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

async function fileExists(client, path, so) {
  const r = await exec(
    client,
    wrapSudo(
      `test -f ${JSON.stringify(path)} && echo Y || echo N`,
      so,
    ),
  );
  return r.stdout.trim() === "Y";
}

async function checkCertKeyMatch(client, certPath, keyPath, so) {
  const certMod = await exec(
    client,
    wrapSudo(
      `openssl x509 -noout -modulus -in ${
        JSON.stringify(certPath)
      } 2>/dev/null | openssl md5`,
      so,
    ),
  );
  const keyMod = await exec(
    client,
    wrapSudo(
      `openssl rsa -noout -modulus -in ${
        JSON.stringify(keyPath)
      } 2>/dev/null | openssl md5`,
      so,
    ),
  );
  if (certMod.exitCode !== 0 || keyMod.exitCode !== 0) return null;
  return certMod.stdout.trim() === keyMod.stdout.trim();
}

async function gather(client, g) {
  const so = sudoOpts(g);

  const certEx = await fileExists(client, g.certPath, so);
  const keyEx = await fileExists(client, g.keyPath, so);
  const chainEx = g.chainPath
    ? await fileExists(client, g.chainPath, so)
    : false;

  const certSha256 = certEx ? await fileHash(client, g.certPath, so) : null;
  const keySha256 = keyEx ? await fileHash(client, g.keyPath, so) : null;
  const chainSha256 = chainEx && g.chainPath
    ? await fileHash(client, g.chainPath, so)
    : null;

  const certKeyMatch = certEx && keyEx
    ? await checkCertKeyMatch(client, g.certPath, g.keyPath, so)
    : null;

  return {
    certExists: certEx,
    keyExists: keyEx,
    chainExists: chainEx,
    certSha256,
    keySha256,
    chainSha256,
    certKeyMatch,
  };
}

async function detectChanges(g, current) {
  const changes = [];

  const desiredCertHash = await hashContent(g.certContent);
  const desiredKeyHash = await hashContent(g.keyContent);

  if (!current.certExists) {
    changes.push("deploy certificate");
  } else if (current.certSha256 !== desiredCertHash) {
    changes.push("update certificate");
  }

  if (!current.keyExists) {
    changes.push("deploy private key");
  } else if (current.keySha256 !== desiredKeyHash) {
    changes.push("update private key");
  }

  if (g.chainContent && g.chainPath) {
    const desiredChainHash = await hashContent(g.chainContent);
    if (!current.chainExists) {
      changes.push("deploy certificate chain");
    } else if (current.chainSha256 !== desiredChainHash) {
      changes.push("update certificate chain");
    }
  }

  return changes;
}

async function deployFile(client, path, content, mode, g) {
  const so = sudoOpts(g);
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) {
    await exec(client, wrapSudo(`mkdir -p ${JSON.stringify(dir)}`, so));
  }
  await writeFileAs(client, path, content, so);
  await exec(client, wrapSudo(`chmod ${mode} ${JSON.stringify(path)}`, so));
  if (g.owner || g.group) {
    const ownership = g.group ? `${g.owner || ""}:${g.group}` : g.owner;
    await exec(
      client,
      wrapSudo(
        `chown ${JSON.stringify(ownership)} ${JSON.stringify(path)}`,
        so,
      ),
    );
  }
}

export const model = {
  type: "@adam/cfgmgmt/certificate",
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
        "Check if certificates are deployed and match desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = await detectChanges(g, current);
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
      description:
        "Deploy certificate, key, and optional chain to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = await detectChanges(g, current);

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

          // Deploy cert
          if (
            changes.includes("deploy certificate") ||
            changes.includes("update certificate")
          ) {
            await deployFile(
              client,
              g.certPath,
              g.certContent,
              g.certMode,
              g,
            );
          }

          // Deploy key
          if (
            changes.includes("deploy private key") ||
            changes.includes("update private key")
          ) {
            await deployFile(
              client,
              g.keyPath,
              g.keyContent,
              g.keyMode,
              g,
            );
          }

          // Deploy chain
          if (
            g.chainContent && g.chainPath &&
            (changes.includes("deploy certificate chain") ||
              changes.includes("update certificate chain"))
          ) {
            await deployFile(
              client,
              g.chainPath,
              g.chainContent,
              g.chainMode,
              g,
            );
          }

          // Validate cert/key match
          if (g.validate) {
            const so = sudoOpts(g);
            const match = await checkCertKeyMatch(
              client,
              g.certPath,
              g.keyPath,
              so,
            );
            if (match === false) {
              throw new Error(
                "Certificate and private key do not match (modulus mismatch)",
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
  reports: [],
};

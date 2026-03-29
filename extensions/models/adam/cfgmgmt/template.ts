// @adam/cfgmgmt/template — Render EJS templates and deploy to remote hosts.
//
// Takes an EJS template string + a variables map, renders the template at
// check/apply time, and deploys the result via SSH (same as the file model).
//
// EJS syntax quick reference:
//   <%= expr %>    Output value (plain interpolation — HTML escaping is disabled)
//   <% code %>     Execute JavaScript (loops, conditionals)
//   <%# comment %> Comment (not included in output)
//
// Whitespace control (use on lines that are only control flow):
//   -%>   Strip the trailing newline (avoids blank lines from loop/conditional tags)
//   <%_   Strip all leading whitespace before the tag
//   _%>   Strip all trailing whitespace after the tag
//
// Example:
//   <% for (const upstream of upstreams) { -%>
//   upstream <%= upstream %>;
//   <% } -%>

import { z } from "npm:zod@4";
import ejs from "npm:ejs@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Absolute path of the file on the remote node"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether file should be present or absent",
  ),
  template: z.string().optional().describe("EJS template string"),
  variables: z.record(z.string(), z.any()).default({}).describe(
    "Template variables passed to EJS",
  ),
  owner: z.string().optional().describe("File owner"),
  group: z.string().optional().describe("File group"),
  mode: z.string().regex(/^[0-7]{3,4}$/, "Mode must be 3-4 octal digits")
    .optional().describe("File permissions in octal (e.g. 0644)"),
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
  path: z.string().describe("File path"),
  ensure: z.string().describe("Desired state (present or absent)"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    exists: z.boolean().describe("Whether the file currently exists"),
    isFile: z.boolean().describe("Whether the path is a regular file"),
    owner: z.string().nullable().describe("Current file owner"),
    group: z.string().nullable().describe("Current file group"),
    mode: z.string().nullable().describe("Current permissions (e.g. 0644)"),
    contentSha256: z.string().nullable().describe(
      "SHA-256 hash of current content",
    ),
  }).describe("Current file state on the remote node"),
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

async function gather(client, path, g) {
  const so = sudoOpts(g);
  const statResult = await execSudo(
    client,
    `stat -c '%F|%U|%G|%a' ${shellEscape(path)} 2>/dev/null || echo 'NOTFOUND'`,
    so,
  );
  const line = statResult.stdout.trim();
  if (line === "NOTFOUND") {
    return {
      exists: false,
      isFile: false,
      owner: null,
      group: null,
      mode: null,
      contentSha256: null,
    };
  }
  const parts = line.split("|");
  if (parts.length < 4) {
    return {
      exists: false,
      isFile: false,
      owner: null,
      group: null,
      mode: null,
      contentSha256: null,
    };
  }
  const [fileType, owner, group, mode] = parts;
  const isFile = fileType === "regular file" ||
    fileType === "regular empty file";

  let contentSha256 = null;
  if (isFile) {
    const hashResult = await execSudo(
      client,
      `sha256sum ${shellEscape(path)} 2>/dev/null | awk '{print $1}'`,
      so,
    );
    contentSha256 = hashResult.stdout.trim() || null;
  }

  return {
    exists: true,
    isFile,
    owner,
    group,
    mode: `0${mode}`,
    contentSha256,
  };
}

function computeDesiredHash(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  return crypto.subtle.digest("SHA-256", data).then(
    (buf) =>
      Array.from(new Uint8Array(buf)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
  );
}

function detectChanges(g, current) {
  const changes = [];
  if (g.ensure === "present") {
    if (!current.exists) {
      changes.push("create file");
    } else if (!current.isFile) {
      changes.push("path exists but is not a regular file");
    }
    if (g.owner && current.owner !== g.owner) {
      changes.push(`owner: ${current.owner} -> ${g.owner}`);
    }
    if (g.group && current.group !== g.group) {
      changes.push(`group: ${current.group} -> ${g.group}`);
    }
    if (g.mode && current.mode !== g.mode) {
      changes.push(`mode: ${current.mode} -> ${g.mode}`);
    }
  } else {
    if (current.exists) changes.push("remove file");
  }
  return changes;
}

// SECURITY: EJS <% %> tags execute JavaScript in the swamp host process, not
// on the remote node. Template content must come from trusted sources (your own
// repository). Never render templates constructed from untrusted user input.
function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return ejs.render(template, variables, { escape: (s: string) => s });
}

export const model = {
  type: "@adam/cfgmgmt/template",
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
      description: "Check if rendered template matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          let renderedContent: string | undefined;
          if (g.ensure === "present" && g.template !== undefined) {
            try {
              renderedContent = renderTemplate(g.template, g.variables);
            } catch (renderErr) {
              const handle = await context.writeResource("state", g.nodeHost, {
                path: g.path,
                ensure: g.ensure,
                status: "failed",
                current: {
                  exists: false,
                  isFile: false,
                  owner: null,
                  group: null,
                  mode: null,
                  contentSha256: null,
                },
                changes: [],
                error: `Template render error: ${renderErr.message}`,
                timestamp: new Date().toISOString(),
              });
              return { dataHandles: [handle] };
            }
          }

          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);

          if (
            g.ensure === "present" && renderedContent !== undefined &&
            current.isFile && current.contentSha256
          ) {
            const desiredHash = await computeDesiredHash(renderedContent);
            if (current.contentSha256 !== desiredHash) {
              changes.push("content differs");
            }
          }

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
            current: {
              exists: false,
              isFile: false,
              owner: null,
              group: null,
              mode: null,
              contentSha256: null,
            },
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
        "Render template and apply desired file state to the remote node",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          let renderedContent: string | undefined;
          if (g.ensure === "present" && g.template !== undefined) {
            try {
              renderedContent = renderTemplate(g.template, g.variables);
            } catch (renderErr) {
              const handle = await context.writeResource("state", g.nodeHost, {
                path: g.path,
                ensure: g.ensure,
                status: "failed",
                current: {
                  exists: false,
                  isFile: false,
                  owner: null,
                  group: null,
                  mode: null,
                  contentSha256: null,
                },
                changes: [],
                error: `Template render error: ${renderErr.message}`,
                timestamp: new Date().toISOString(),
              });
              return { dataHandles: [handle] };
            }
          }

          const client = await connect(g);
          const current = await gather(client, g.path, g);
          const changes = detectChanges(g, current);

          if (
            g.ensure === "present" && renderedContent !== undefined &&
            current.isFile && current.contentSha256
          ) {
            const desiredHash = await computeDesiredHash(renderedContent);
            if (current.contentSha256 !== desiredHash) {
              changes.push("content differs");
            }
          }

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
          if (g.ensure === "absent") {
            await execSudo(client, `rm -f ${shellEscape(g.path)}`, so);
          } else {
            const dir = g.path.substring(0, g.path.lastIndexOf("/"));
            if (dir) {
              await execSudo(
                client,
                `mkdir -p ${shellEscape(dir)}`,
                so,
              );
            }
            if (renderedContent !== undefined) {
              await writeFileAs(client, g.path, renderedContent, so);
            }
            if (g.owner || g.group) {
              const ownership = g.group
                ? `${g.owner || ""}:${g.group}`
                : g.owner;
              await execSudo(
                client,
                `chown ${shellEscape(ownership)} ${shellEscape(g.path)}`,
                so,
              );
            }
            if (g.mode) {
              await execSudo(
                client,
                `chmod ${g.mode} ${shellEscape(g.path)}`,
                so,
              );
            }
          }

          const updated = await gather(client, g.path, g);
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
            current: {
              exists: false,
              isFile: false,
              owner: null,
              group: null,
              mode: null,
              contentSha256: null,
            },
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

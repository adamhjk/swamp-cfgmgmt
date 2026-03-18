import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo, writeFileAs } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  path: z.string().describe("Absolute path of the file on the remote node"),
  regexp: z.string().describe(
    "Regular expression to match the target line. First match is used.",
  ),
  line: z.string().optional().describe(
    "The line to insert or replace. Required when ensure is present.",
  ),
  ensure: z.enum(["present", "absent"]).default("present").describe(
    "Whether the matching line should be present or absent",
  ),
  insertAfter: z.string().optional().describe(
    "Regex pattern — insert the line after the last match of this pattern if regexp has no match. Defaults to EOF.",
  ),
  insertBefore: z.string().optional().describe(
    "Regex pattern — insert the line before the first match of this pattern if regexp has no match",
  ),
  createFile: z.boolean().default(true).describe(
    "Create the file if it does not exist (ensure=present only)",
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
  path: z.string().describe("File path"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    fileExists: z.boolean().describe("Whether the file exists"),
    matchFound: z.boolean().describe(
      "Whether the regexp matched a line in the file",
    ),
    matchedLine: z.string().nullable().describe("The line that matched"),
    lineNumber: z.number().nullable().describe(
      "Line number of the match (1-based)",
    ),
  }).describe("Current state on the remote node"),
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
    fileExists: false,
    matchFound: false,
    matchedLine: null,
    lineNumber: null,
  };
}

async function gather(client, g) {
  const so = sudoOpts(g);
  const fileCheck = await exec(
    client,
    wrapSudo(
      `test -f ${JSON.stringify(g.path)} && echo Y || echo N`,
      so,
    ),
  );
  const fileExists = fileCheck.stdout.trim() === "Y";

  if (!fileExists) {
    return {
      fileExists,
      matchFound: false,
      matchedLine: null,
      lineNumber: null,
      lines: [],
    };
  }

  const catResult = await exec(
    client,
    wrapSudo(`cat ${JSON.stringify(g.path)}`, so),
  );
  const lines = catResult.stdout.split("\n");
  // Remove trailing empty element from split if file ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const re = new RegExp(g.regexp);
  let matchedLine = null;
  let lineNumber = null;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matchedLine = lines[i];
      lineNumber = i + 1;
      break;
    }
  }

  return {
    fileExists,
    matchFound: matchedLine !== null,
    matchedLine,
    lineNumber,
    lines,
  };
}

function detectChanges(g, current) {
  const changes = [];

  if (g.ensure === "present") {
    if (!current.fileExists) {
      if (g.createFile) {
        changes.push("create file and add line");
      } else {
        changes.push("file does not exist");
      }
    } else if (!current.matchFound) {
      changes.push("add line");
    } else if (current.matchedLine !== g.line) {
      changes.push(
        `replace line ${current.lineNumber}: ${
          JSON.stringify(current.matchedLine)
        } -> ${JSON.stringify(g.line)}`,
      );
    }
  } else {
    if (current.fileExists && current.matchFound) {
      changes.push(
        `remove line ${current.lineNumber}: ${
          JSON.stringify(current.matchedLine)
        }`,
      );
    }
  }

  return changes;
}

function applyLineEdit(g, lines, current) {
  const result = [...lines];

  if (g.ensure === "present") {
    if (current.matchFound && current.lineNumber !== null) {
      // Replace existing line
      result[current.lineNumber - 1] = g.line;
    } else {
      // Insert new line
      if (g.insertBefore) {
        const re = new RegExp(g.insertBefore);
        const idx = result.findIndex((l) => re.test(l));
        if (idx >= 0) {
          result.splice(idx, 0, g.line);
          return result;
        }
      }
      if (g.insertAfter) {
        const re = new RegExp(g.insertAfter);
        let lastIdx = -1;
        for (let i = 0; i < result.length; i++) {
          if (re.test(result[i])) lastIdx = i;
        }
        if (lastIdx >= 0) {
          result.splice(lastIdx + 1, 0, g.line);
          return result;
        }
      }
      // Default: append to end
      result.push(g.line);
    }
  } else {
    // Remove matching line
    if (current.matchFound && current.lineNumber !== null) {
      result.splice(current.lineNumber - 1, 1);
    }
  }

  return result;
}

export const model = {
  type: "@adam/cfgmgmt/line",
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
        "Check if the line matches desired state in the file (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            current: {
              fileExists: current.fileExists,
              matchFound: current.matchFound,
              matchedLine: current.matchedLine,
              lineNumber: current.lineNumber,
            },
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
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
      description: "Ensure a line is present/absent in the file",
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
              status: "compliant",
              current: {
                fileExists: current.fileExists,
                matchFound: current.matchFound,
                matchedLine: current.matchedLine,
                lineNumber: current.lineNumber,
              },
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          if (!current.fileExists && g.ensure === "present" && !g.createFile) {
            throw new Error(`File does not exist: ${g.path}`);
          }

          const so = sudoOpts(g);
          const lines = current.fileExists ? current.lines : [];
          const newLines = applyLineEdit(g, lines, current);
          const newContent = newLines.join("\n") + "\n";

          const dir = g.path.substring(0, g.path.lastIndexOf("/"));
          if (dir && !current.fileExists) {
            await exec(
              client,
              wrapSudo(`mkdir -p ${JSON.stringify(dir)}`, so),
            );
          }

          await writeFileAs(client, g.path, newContent, so);

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            path: g.path,
            status: "applied",
            current: {
              fileExists: updated.fileExists,
              matchFound: updated.matchFound,
              matchedLine: updated.matchedLine,
              lineNumber: updated.lineNumber,
            },
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            path: g.path,
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

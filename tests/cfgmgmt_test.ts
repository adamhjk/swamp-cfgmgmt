/**
 * End-to-end tests for cfgmgmt extension models.
 * Drives swamp CLI against a localhost SSH node.
 *
 * Prerequisites:
 *   - SSH to localhost must work with /tmp/cfgmgmt-test-key
 *   - Generate with: ssh-keygen -t ed25519 -f /tmp/cfgmgmt-test-key -N ""
 *   - Authorize with: cat /tmp/cfgmgmt-test-key.pub >> ~/.ssh/authorized_keys
 *
 * Run: deno test tests/cfgmgmt_test.ts --allow-run --allow-read --allow-write --allow-env
 */

const TIMESTAMP = Date.now();
const TEST_DIR = `/tmp/cfgmgmt-test-${TIMESTAMP}`;
const TEST_FILE = `${TEST_DIR}/hello.txt`;
const TEST_LINK = `${TEST_DIR}/link.txt`;
const USER = Deno.env.get("USER") || "adam";
const SSH_KEY = "/tmp/cfgmgmt-test-key";

const TEST_TEMPLATE_FILE = `${TEST_DIR}/rendered.conf`;
const TEST_LINE_FILE = `${TEST_DIR}/line-test.conf`;
const TEST_FETCH_FILE = `${TEST_DIR}/fetched.txt`;

const NODE_NAME = `test-node-${TIMESTAMP}`;
const DIR_NAME = `test-dir-${TIMESTAMP}`;
const FILE_NAME = `test-file-${TIMESTAMP}`;
const LINK_NAME = `test-link-${TIMESTAMP}`;
const TEMPLATE_NAME = `test-template-${TIMESTAMP}`;
const LINE_NAME = `test-line-${TIMESTAMP}`;
const FETCH_NAME = `test-fetch-${TIMESTAMP}`;

const modelNames = [
  NODE_NAME,
  DIR_NAME,
  FILE_NAME,
  LINK_NAME,
  TEMPLATE_NAME,
  LINE_NAME,
  FETCH_NAME,
];
const modelPaths: Record<string, string> = {};

interface SwampResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function swamp(...args: string[]): Promise<SwampResult> {
  const cmd = new Deno.Command("swamp", {
    args,
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.env.get("SWAMP_REPO") || undefined,
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

function parseJson(text: string): unknown {
  const lines = text.split("\n");
  const jsonStart = lines.findIndex((l) =>
    l.startsWith("{") || l.startsWith("[")
  );
  if (jsonStart === -1) throw new Error(`No JSON in output:\n${text}`);
  return JSON.parse(lines.slice(jsonStart).join("\n"));
}

async function swampJson(...args: string[]): Promise<Record<string, unknown>> {
  const result = await swamp(...args);
  if (result.code !== 0) {
    throw new Error(
      `swamp ${
        args.join(" ")
      } failed (exit ${result.code}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  return parseJson(result.stdout) as Record<string, unknown>;
}

async function runMethod(
  name: string,
  method: string,
): Promise<Record<string, unknown>> {
  const result = await swampJson(
    "model",
    "method",
    "run",
    name,
    method,
    "--json",
  );
  const data = result.data as Record<string, unknown>;
  return data.attributes as Record<string, unknown>;
}

async function createAndEdit(
  type: string,
  name: string,
  globalArgs: string,
): Promise<void> {
  const created = await swampJson("model", "create", type, name, "--json");
  const yamlPath = created.path as string;
  modelPaths[name] = yamlPath;

  const content = await Deno.readTextFile(yamlPath);
  const edited = content.replace(
    /globalArguments:[\s\S]*?(?=\nmethods:|\nversion:)/,
    `globalArguments:\n${globalArgs}`,
  );
  await Deno.writeTextFile(yamlPath, edited);
}

async function setup() {
  await createAndEdit(
    "@adam/cfgmgmt/node",
    NODE_NAME,
    [
      `  hostname: "127.0.0.1"`,
      `  sshUser: "${USER}"`,
      `  sshPort: 22`,
      `  sshIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/directory",
    DIR_NAME,
    [
      `  path: "${TEST_DIR}"`,
      `  ensure: present`,
      `  owner: "${USER}"`,
      `  mode: "0755"`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/file",
    FILE_NAME,
    [
      `  path: "${TEST_FILE}"`,
      `  ensure: present`,
      `  content: "hello world\\n"`,
      `  owner: "${USER}"`,
      `  mode: "0644"`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/link",
    LINK_NAME,
    [
      `  path: "${TEST_LINK}"`,
      `  ensure: present`,
      `  target: "${TEST_FILE}"`,
      `  owner: "${USER}"`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/template",
    TEMPLATE_NAME,
    [
      `  path: "${TEST_TEMPLATE_FILE}"`,
      `  ensure: present`,
      `  template: "hello <%= name %>, port=<%= port %>\\n"`,
      `  variables:`,
      `    name: world`,
      `    port: 8080`,
      `  owner: "${USER}"`,
      `  mode: "0644"`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/line",
    LINE_NAME,
    [
      `  path: "${TEST_LINE_FILE}"`,
      `  regexp: "^worker_processes"`,
      `  line: "worker_processes auto;"`,
      `  ensure: present`,
      `  createFile: true`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await createAndEdit(
    "@adam/cfgmgmt/fetch",
    FETCH_NAME,
    [
      `  url: "file://${TEST_FILE}"`,
      `  path: "${TEST_FETCH_FILE}"`,
      `  owner: "${USER}"`,
      `  mode: "0644"`,
      `  nodeHost: "127.0.0.1"`,
      `  nodeUser: "${USER}"`,
      `  nodePort: 22`,
      `  nodeIdentityFile: "${SSH_KEY}"`,
    ].join("\n") + "\n",
  );

  await swamp("repo", "index");

  for (const name of modelNames) {
    const validation = await swampJson("model", "validate", name, "--json");
    if (!validation.passed) {
      throw new Error(
        `Validation failed for ${name}:\n${
          JSON.stringify(validation, null, 2)
        }`,
      );
    }
  }
}

async function editModelEnsure(
  name: string,
  from: string,
  to: string,
): Promise<void> {
  const yamlPath = modelPaths[name];
  const content = await Deno.readTextFile(yamlPath);
  await Deno.writeTextFile(
    yamlPath,
    content.replace(`ensure: ${from}`, `ensure: ${to}`),
  );
  await swamp("repo", "index");
}

async function cleanup() {
  for (const name of modelNames) {
    try {
      await swamp("model", "delete", name, "--force", "--json");
    } catch { /* ignore */ }
  }
  try {
    await Deno.remove(TEST_DIR, { recursive: true });
  } catch { /* ignore */ }
}

Deno.test({
  name: "cfgmgmt e2e",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await cleanup();
    await setup();

    try {
      await t.step("model types registered", async () => {
        const result = await swampJson("model", "type", "search", "--json");
        const types = (result.results as Array<Record<string, string>>).map((
          r,
        ) => r.raw);
        for (
          const e of [
            "@adam/cfgmgmt/node",
            "@adam/cfgmgmt/file",
            "@adam/cfgmgmt/template",
            "@adam/cfgmgmt/directory",
            "@adam/cfgmgmt/link",
            "@adam/cfgmgmt/line",
            "@adam/cfgmgmt/fetch",
            "@adam/cfgmgmt/apt_repository",
            "@adam/cfgmgmt/dnf_repository",
            "@adam/cfgmgmt/kernel_module",
            "@adam/cfgmgmt/reboot",
            "@adam/cfgmgmt/certificate",
          ]
        ) {
          if (!types.includes(e)) throw new Error(`Missing type: ${e}`);
        }
      });

      await t.step("check detects non-compliant file", async () => {
        const state = await runMethod(FILE_NAME, "check");
        if (state.status !== "non_compliant") {
          throw new Error(`Expected non_compliant, got: ${state.status}`);
        }
        if ((state.changes as string[]).length === 0) {
          throw new Error("Expected non-empty changes");
        }
      });

      await t.step("apply creates directory", async () => {
        const state = await runMethod(DIR_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const stat = await Deno.stat(TEST_DIR);
        if (!stat.isDirectory) throw new Error("Expected directory to exist");
      });

      await t.step("apply creates file", async () => {
        const state = await runMethod(FILE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_FILE);
        if (content !== "hello world\n") {
          throw new Error(
            `Expected 'hello world\\n', got: ${JSON.stringify(content)}`,
          );
        }
      });

      await t.step("apply creates symlink", async () => {
        const state = await runMethod(LINK_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const linkInfo = await Deno.lstat(TEST_LINK);
        if (!linkInfo.isSymlink) throw new Error("Expected symlink to exist");
        const target = await Deno.readLink(TEST_LINK);
        if (target !== TEST_FILE) {
          throw new Error(`Expected target ${TEST_FILE}, got: ${target}`);
        }
      });

      await t.step("check after apply is compliant", async () => {
        const state = await runMethod(FILE_NAME, "check");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant, got: ${state.status}\nChanges: ${
              JSON.stringify(state.changes)
            }`,
          );
        }
        if ((state.changes as string[]).length !== 0) {
          throw new Error(
            `Expected empty changes, got: ${JSON.stringify(state.changes)}`,
          );
        }
      });

      await t.step("apply is idempotent", async () => {
        const state = await runMethod(FILE_NAME, "apply");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant (idempotent), got: ${state.status}`,
          );
        }
      });

      await t.step("template check detects non-compliant", async () => {
        const state = await runMethod(TEMPLATE_NAME, "check");
        if (state.status !== "non_compliant") {
          throw new Error(`Expected non_compliant, got: ${state.status}`);
        }
      });

      await t.step("template apply creates rendered file", async () => {
        const state = await runMethod(TEMPLATE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_TEMPLATE_FILE);
        if (content !== "hello world, port=8080\n") {
          throw new Error(
            `Expected 'hello world, port=8080\\n', got: ${
              JSON.stringify(content)
            }`,
          );
        }
      });

      await t.step("template check after apply is compliant", async () => {
        const state = await runMethod(TEMPLATE_NAME, "check");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant, got: ${state.status}\nChanges: ${
              JSON.stringify(state.changes)
            }`,
          );
        }
      });

      await t.step("template apply is idempotent", async () => {
        const state = await runMethod(TEMPLATE_NAME, "apply");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant (idempotent), got: ${state.status}`,
          );
        }
      });

      await t.step(
        "template variable change detects non-compliant",
        async () => {
          const yamlPath = modelPaths[TEMPLATE_NAME];
          const content = await Deno.readTextFile(yamlPath);
          await Deno.writeTextFile(
            yamlPath,
            content.replace("name: world", "name: swamp"),
          );
          await swamp("repo", "index");

          const state = await runMethod(TEMPLATE_NAME, "check");
          if (state.status !== "non_compliant") {
            throw new Error(`Expected non_compliant, got: ${state.status}`);
          }
        },
      );

      await t.step("template apply with changed variable", async () => {
        const state = await runMethod(TEMPLATE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_TEMPLATE_FILE);
        if (content !== "hello swamp, port=8080\n") {
          throw new Error(
            `Expected 'hello swamp, port=8080\\n', got: ${
              JSON.stringify(content)
            }`,
          );
        }
      });

      await t.step("template apply absent removes file", async () => {
        await editModelEnsure(TEMPLATE_NAME, "present", "absent");
        const state = await runMethod(TEMPLATE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        try {
          await Deno.stat(TEST_TEMPLATE_FILE);
          throw new Error("Template file should not exist after absent apply");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      });

      // --- line model tests ---

      await t.step(
        "line check detects non-compliant (file missing)",
        async () => {
          const state = await runMethod(LINE_NAME, "check");
          if (state.status !== "non_compliant") {
            throw new Error(`Expected non_compliant, got: ${state.status}`);
          }
        },
      );

      await t.step("line apply creates file with line", async () => {
        const state = await runMethod(LINE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_LINE_FILE);
        if (!content.includes("worker_processes auto;")) {
          throw new Error(
            `Expected line in file, got: ${JSON.stringify(content)}`,
          );
        }
      });

      await t.step("line check after apply is compliant", async () => {
        const state = await runMethod(LINE_NAME, "check");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant, got: ${state.status}\nChanges: ${
              JSON.stringify(state.changes)
            }`,
          );
        }
      });

      await t.step("line apply is idempotent", async () => {
        const state = await runMethod(LINE_NAME, "apply");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant (idempotent), got: ${state.status}`,
          );
        }
      });

      await t.step("line replace detects change", async () => {
        const yamlPath = modelPaths[LINE_NAME];
        const content = await Deno.readTextFile(yamlPath);
        await Deno.writeTextFile(
          yamlPath,
          content.replace("worker_processes auto;", "worker_processes 4;"),
        );
        await swamp("repo", "index");

        const state = await runMethod(LINE_NAME, "check");
        if (state.status !== "non_compliant") {
          throw new Error(`Expected non_compliant, got: ${state.status}`);
        }
      });

      await t.step("line apply replaces line", async () => {
        const state = await runMethod(LINE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_LINE_FILE);
        if (!content.includes("worker_processes 4;")) {
          throw new Error(
            `Expected updated line, got: ${JSON.stringify(content)}`,
          );
        }
      });

      await t.step("line absent removes matching line", async () => {
        await editModelEnsure(LINE_NAME, "present", "absent");
        const state = await runMethod(LINE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const content = await Deno.readTextFile(TEST_LINE_FILE);
        if (content.includes("worker_processes")) {
          throw new Error(
            `Expected line removed, got: ${JSON.stringify(content)}`,
          );
        }
      });

      // --- fetch model tests ---

      await t.step("fetch check detects non-compliant", async () => {
        const state = await runMethod(FETCH_NAME, "check");
        if (state.status !== "non_compliant") {
          throw new Error(`Expected non_compliant, got: ${state.status}`);
        }
      });

      await t.step("fetch apply downloads file", async () => {
        const state = await runMethod(FETCH_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        const exists = await Deno.stat(TEST_FETCH_FILE).then(
          () => true,
          () => false,
        );
        if (!exists) throw new Error("Expected fetched file to exist");
      });

      await t.step("fetch apply is idempotent", async () => {
        const state = await runMethod(FETCH_NAME, "apply");
        if (state.status !== "compliant") {
          throw new Error(
            `Expected compliant (idempotent), got: ${state.status}`,
          );
        }
      });

      // --- cleanup section ---

      await t.step("apply absent removes symlink", async () => {
        await editModelEnsure(LINK_NAME, "present", "absent");
        const state = await runMethod(LINK_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        try {
          await Deno.lstat(TEST_LINK);
          throw new Error("Symlink should not exist after absent apply");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      });

      await t.step("apply absent removes file", async () => {
        await editModelEnsure(FILE_NAME, "present", "absent");
        const state = await runMethod(FILE_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        try {
          await Deno.stat(TEST_FILE);
          throw new Error("File should not exist after absent apply");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      });

      await t.step("apply absent removes directory", async () => {
        await editModelEnsure(DIR_NAME, "present", "absent");
        const state = await runMethod(DIR_NAME, "apply");
        if (state.status !== "applied") {
          throw new Error(
            `Expected applied, got: ${state.status}\nError: ${state.error}`,
          );
        }
        try {
          await Deno.stat(TEST_DIR);
          throw new Error("Directory should not exist after absent apply");
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      });
    } finally {
      await cleanup();
    }
  },
});

import { z } from "npm:zod@4";
import { exec, getConnection, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  image: z.string().describe("Docker image name with tag (e.g. nginx:1.25)"),
  ensure: z.enum(["present", "absent"]).describe(
    "Whether image should be present or absent",
  ),
  force: z.boolean().default(false).describe(
    "Force pull even if image is already present",
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
  image: z.string().describe("Docker image name"),
  ensure: z.string().describe("Desired state"),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe(
    "Compliance status",
  ),
  current: z.object({
    imageExists: z.boolean().describe("Whether the image exists locally"),
    imageId: z.string().nullable().describe("Image ID"),
    tags: z.array(z.string()).describe("Image tags"),
    created: z.string().nullable().describe("Image creation timestamp"),
    size: z.number().nullable().describe("Image size in bytes"),
  }).describe("Current Docker image state"),
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

  const dockerCheck = await exec(
    client,
    wrapSudo(`command -v docker`, so),
  );
  if (dockerCheck.exitCode !== 0) {
    throw new Error("Docker is not installed");
  }

  const result = await exec(
    client,
    wrapSudo(
      `docker image inspect ${
        JSON.stringify(g.image)
      } --format '{{.Id}}|||{{json .RepoTags}}|||{{.Created}}|||{{.Size}}' 2>/dev/null`,
      so,
    ),
  );

  if (result.exitCode !== 0) {
    return {
      imageExists: false,
      imageId: null,
      tags: [] as string[],
      created: null,
      size: null,
    };
  }

  const parts = result.stdout.trim().split("|||");
  let tags: string[] = [];
  try {
    tags = JSON.parse(parts[1] || "[]");
  } catch {
    tags = [];
  }

  return {
    imageExists: true,
    imageId: parts[0] || null,
    tags,
    created: parts[2] || null,
    size: parts[3] ? parseInt(parts[3], 10) : null,
  };
}

function detectChanges(g, current) {
  const changes: string[] = [];
  if (g.ensure === "present") {
    if (!current.imageExists) {
      changes.push("pull image");
    } else if (g.force) {
      changes.push("force pull image");
    }
  } else {
    if (current.imageExists) changes.push("remove image");
  }
  return changes;
}

function emptyCurrent() {
  return {
    imageExists: false,
    imageId: null,
    tags: [] as string[],
    created: null,
    size: null,
  };
}

export const model = {
  type: "@adam/cfgmgmt/docker_image",
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
      description: "Check if Docker image matches desired state (dry-run)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);
          const handle = await context.writeResource("state", g.nodeHost, {
            image: g.image,
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
            image: g.image,
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
      description: "Pull or remove a Docker image",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const current = await gather(client, g);
          const changes = detectChanges(g, current);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              image: g.image,
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
            const result = await exec(
              client,
              wrapSudo(`docker rmi ${JSON.stringify(g.image)}`, so),
            );
            if (result.exitCode !== 0) {
              throw new Error(`docker rmi failed: ${result.stderr}`);
            }
          } else {
            const result = await exec(
              client,
              wrapSudo(`docker pull ${JSON.stringify(g.image)}`, so),
            );
            if (result.exitCode !== 0) {
              throw new Error(`docker pull failed: ${result.stderr}`);
            }
          }

          const updated = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            image: g.image,
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
            image: g.image,
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
    prune: {
      description: "Remove dangling Docker images (imperative, always runs)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const result = await exec(
            client,
            wrapSudo(`docker image prune -f`, so),
          );
          const current = await gather(client, g);
          const failed = result.exitCode !== 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            image: g.image,
            ensure: g.ensure,
            status: failed ? "failed" : "applied",
            current,
            changes: ["prune dangling images"],
            error: failed ? result.stderr : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(result.stderr);
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            image: g.image,
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

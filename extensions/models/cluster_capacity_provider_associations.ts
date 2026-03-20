// Auto-generated extension model for @swamp/aws/ecs/cluster-capacity-provider-associations
// Do not edit manually. Re-generate with: deno task generate:aws

// deno-lint-ignore-file no-explicit-any

import { z } from "zod";
import {
  createResource,
  deleteResource,
  isResourceNotFoundError,
  readResource,
  updateResource,
} from "./_lib/aws.ts";

export const CapacityProviderStrategySchema = z.object({
  CapacityProvider: z.string().describe(
    "If using ec2 auto-scaling, the name of the associated capacity provider. Otherwise FARGATE, FARGATE_SPOT.",
  ),
  Base: z.number().int().min(0).max(100000).optional(),
  Weight: z.number().int().min(0).max(1000).optional(),
});

const GlobalArgsSchema = z.object({
  DefaultCapacityProviderStrategy: z.array(CapacityProviderStrategySchema)
    .describe("List of capacity providers to associate with the cluster"),
  CapacityProviders: z.array(z.string()).describe(
    "List of capacity providers to associate with the cluster",
  ).optional(),
  Cluster: z.string().min(1).max(2048).describe("The name of the cluster"),
});

const StateSchema = z.object({
  DefaultCapacityProviderStrategy: z.array(CapacityProviderStrategySchema)
    .optional(),
  CapacityProviders: z.array(z.string()).optional(),
  Cluster: z.string(),
}).passthrough();

type StateData = z.infer<typeof StateSchema>;

const InputsSchema = z.object({
  DefaultCapacityProviderStrategy: z.array(CapacityProviderStrategySchema)
    .describe("List of capacity providers to associate with the cluster")
    .optional(),
  CapacityProviders: z.array(z.string()).describe(
    "List of capacity providers to associate with the cluster",
  ).optional(),
  Cluster: z.string().min(1).max(2048).describe("The name of the cluster")
    .optional(),
});

export const model = {
  type: "@swamp/aws/ecs/cluster-capacity-provider-associations",
  version: "2026.03.19.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: InputsSchema,
  resources: {
    state: {
      description: "ECS ClusterCapacityProviderAssociations resource state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a ECS ClusterCapacityProviderAssociations",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const desiredState: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(g)) {
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await createResource(
          "AWS::ECS::ClusterCapacityProviderAssociations",
          desiredState,
        ) as StateData;
        const instanceName = (result.Cluster ?? g.Cluster)?.toString() ??
          "current";
        const handle = await context.writeResource(
          "state",
          instanceName,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    get: {
      description: "Get a ECS ClusterCapacityProviderAssociations",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS ClusterCapacityProviderAssociations",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const result = await readResource(
          "AWS::ECS::ClusterCapacityProviderAssociations",
          args.identifier,
        ) as StateData;
        const instanceName =
          (result.Cluster ?? context.globalArgs.Cluster)?.toString() ??
            args.identifier;
        const handle = await context.writeResource(
          "state",
          instanceName,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Update a ECS ClusterCapacityProviderAssociations",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.Cluster?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.Cluster?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        const currentState = await readResource(
          "AWS::ECS::ClusterCapacityProviderAssociations",
          identifier,
        ) as StateData;
        const desiredState: Record<string, unknown> = { ...currentState };
        for (const [key, value] of Object.entries(g)) {
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await updateResource(
          "AWS::ECS::ClusterCapacityProviderAssociations",
          identifier,
          currentState,
          desiredState,
          ["Cluster"],
        );
        const handle = await context.writeResource(
          "state",
          instanceName,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete a ECS ClusterCapacityProviderAssociations",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS ClusterCapacityProviderAssociations",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const { existed } = await deleteResource(
          "AWS::ECS::ClusterCapacityProviderAssociations",
          args.identifier,
        );
        const instanceName = context.globalArgs.Cluster?.toString() ??
          args.identifier;
        const handle = await context.writeResource("state", instanceName, {
          identifier: args.identifier,
          existed,
          status: existed ? "deleted" : "not_found",
          deletedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Sync ECS ClusterCapacityProviderAssociations state from AWS",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.Cluster?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.Cluster?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        try {
          const result = await readResource(
            "AWS::ECS::ClusterCapacityProviderAssociations",
            identifier,
          ) as StateData;
          const handle = await context.writeResource(
            "state",
            instanceName,
            result,
          );
          return { dataHandles: [handle] };
        } catch (error: unknown) {
          if (isResourceNotFoundError(error)) {
            const handle = await context.writeResource("state", instanceName, {
              identifier,
              status: "not_found",
              syncedAt: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
          throw error;
        }
      },
    },
  },
};

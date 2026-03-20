// Auto-generated extension model for @swamp/aws/ecs/express-gateway-service
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

export const ExpressGatewayRepositoryCredentialsSchema = z.object({
  CredentialsParameter: z.string(),
});

export const SecretSchema = z.object({
  ValueFrom: z.string(),
  Name: z.string(),
});

export const ExpressGatewayServiceAwsLogsConfigurationSchema = z.object({
  LogStreamPrefix: z.string(),
  LogGroup: z.string(),
});

export const KeyValuePairSchema = z.object({
  Value: z.string(),
  Name: z.string(),
});

export const TagSchema = z.object({
  Value: z.string(),
  Key: z.string(),
});

const GlobalArgsSchema = z.object({
  name: z.string().describe(
    "Instance name for this resource (used as the unique identifier in the factory pattern)",
  ),
  Status: z.object({
    StatusCode: z.enum(["ACTIVE", "DRAINING", "INACTIVE"]).optional(),
  }).optional(),
  TaskRoleArn: z.string().optional(),
  PrimaryContainer: z.object({
    RepositoryCredentials: ExpressGatewayRepositoryCredentialsSchema.optional(),
    Secrets: z.array(SecretSchema).optional(),
    Command: z.array(z.string()).optional(),
    AwsLogsConfiguration: ExpressGatewayServiceAwsLogsConfigurationSchema
      .optional(),
    ContainerPort: z.number().int().optional(),
    Environment: z.array(KeyValuePairSchema).optional(),
    Image: z.string(),
  }),
  Memory: z.string().optional(),
  HealthCheckPath: z.string().optional(),
  Cluster: z.string().optional(),
  Cpu: z.string().optional(),
  ExecutionRoleArn: z.string(),
  InfrastructureRoleArn: z.string(),
  ScalingTarget: z.object({
    MinTaskCount: z.number().int().optional(),
    MaxTaskCount: z.number().int().optional(),
    AutoScalingMetric: z.enum([
      "AVERAGE_CPU",
      "AVERAGE_MEMORY",
      "REQUEST_COUNT_PER_TARGET",
    ]).optional(),
    AutoScalingTargetValue: z.number().int().optional(),
  }).optional(),
  ServiceName: z.string().optional(),
  NetworkConfiguration: z.object({
    SecurityGroups: z.array(z.string()).optional(),
    Subnets: z.array(z.string()).optional(),
  }).optional(),
  Tags: z.array(TagSchema).optional(),
});

const StateSchema = z.object({
  Status: z.object({
    StatusCode: z.string(),
  }).optional(),
  TaskRoleArn: z.string().optional(),
  PrimaryContainer: z.object({
    RepositoryCredentials: ExpressGatewayRepositoryCredentialsSchema,
    Secrets: z.array(SecretSchema),
    Command: z.array(z.string()),
    AwsLogsConfiguration: ExpressGatewayServiceAwsLogsConfigurationSchema,
    ContainerPort: z.number(),
    Environment: z.array(KeyValuePairSchema),
    Image: z.string(),
  }).optional(),
  Memory: z.string().optional(),
  HealthCheckPath: z.string().optional(),
  CreatedAt: z.string().optional(),
  Cluster: z.string().optional(),
  Cpu: z.string().optional(),
  ServiceArn: z.string(),
  ECSManagedResourceArns: z.object({
    LogGroups: z.array(z.string()),
    ServiceSecurityGroups: z.array(z.string()),
    MetricAlarms: z.array(z.string()),
    IngressPath: z.object({
      ListenerArn: z.string(),
      LoadBalancerArn: z.string(),
      TargetGroupArns: z.array(z.string()),
      ListenerRuleArn: z.string(),
      LoadBalancerSecurityGroups: z.array(z.string()),
      CertificateArn: z.string(),
    }),
    AutoScaling: z.object({
      ScalableTarget: z.string(),
      ApplicationAutoScalingPolicies: z.array(z.string()),
    }),
  }).optional(),
  UpdatedAt: z.string().optional(),
  ExecutionRoleArn: z.string().optional(),
  InfrastructureRoleArn: z.string().optional(),
  ScalingTarget: z.object({
    MinTaskCount: z.number(),
    MaxTaskCount: z.number(),
    AutoScalingMetric: z.string(),
    AutoScalingTargetValue: z.number(),
  }).optional(),
  ActiveConfigurations: z.array(z.object({
    ServiceRevisionArn: z.string(),
    ExecutionRoleArn: z.string(),
    TaskRoleArn: z.string(),
    ScalingTarget: z.object({
      MinTaskCount: z.number(),
      MaxTaskCount: z.number(),
      AutoScalingMetric: z.string(),
      AutoScalingTargetValue: z.number(),
    }),
    IngressPaths: z.array(z.object({
      Endpoint: z.string(),
      AccessType: z.string(),
    })),
    PrimaryContainer: z.object({
      RepositoryCredentials: ExpressGatewayRepositoryCredentialsSchema,
      Secrets: z.array(SecretSchema),
      Command: z.array(z.string()),
      AwsLogsConfiguration: ExpressGatewayServiceAwsLogsConfigurationSchema,
      ContainerPort: z.number(),
      Environment: z.array(KeyValuePairSchema),
      Image: z.string(),
    }),
    Memory: z.string(),
    HealthCheckPath: z.string(),
    CreatedAt: z.string(),
    Cpu: z.string(),
    NetworkConfiguration: z.object({
      SecurityGroups: z.array(z.string()),
      Subnets: z.array(z.string()),
    }),
  })).optional(),
  Endpoint: z.string().optional(),
  ServiceName: z.string().optional(),
  NetworkConfiguration: z.object({
    SecurityGroups: z.array(z.string()),
    Subnets: z.array(z.string()),
  }).optional(),
  Tags: z.array(TagSchema).optional(),
}).passthrough();

type StateData = z.infer<typeof StateSchema>;

const InputsSchema = z.object({
  name: z.string().optional(),
  Status: z.object({
    StatusCode: z.enum(["ACTIVE", "DRAINING", "INACTIVE"]).optional(),
  }).optional(),
  TaskRoleArn: z.string().optional(),
  PrimaryContainer: z.object({
    RepositoryCredentials: ExpressGatewayRepositoryCredentialsSchema.optional(),
    Secrets: z.array(SecretSchema).optional(),
    Command: z.array(z.string()).optional(),
    AwsLogsConfiguration: ExpressGatewayServiceAwsLogsConfigurationSchema
      .optional(),
    ContainerPort: z.number().int().optional(),
    Environment: z.array(KeyValuePairSchema).optional(),
    Image: z.string().optional(),
  }).optional(),
  Memory: z.string().optional(),
  HealthCheckPath: z.string().optional(),
  Cluster: z.string().optional(),
  Cpu: z.string().optional(),
  ExecutionRoleArn: z.string().optional(),
  InfrastructureRoleArn: z.string().optional(),
  ScalingTarget: z.object({
    MinTaskCount: z.number().int().optional(),
    MaxTaskCount: z.number().int().optional(),
    AutoScalingMetric: z.enum([
      "AVERAGE_CPU",
      "AVERAGE_MEMORY",
      "REQUEST_COUNT_PER_TARGET",
    ]).optional(),
    AutoScalingTargetValue: z.number().int().optional(),
  }).optional(),
  ServiceName: z.string().optional(),
  NetworkConfiguration: z.object({
    SecurityGroups: z.array(z.string()).optional(),
    Subnets: z.array(z.string()).optional(),
  }).optional(),
  Tags: z.array(TagSchema).optional(),
});

export const model = {
  type: "@swamp/aws/ecs/express-gateway-service",
  version: "2026.03.19.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: InputsSchema,
  resources: {
    state: {
      description: "ECS ExpressGatewayService resource state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a ECS ExpressGatewayService",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const desiredState: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(g)) {
          if (key === "name") continue;
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await createResource(
          "AWS::ECS::ExpressGatewayService",
          desiredState,
        ) as StateData;
        const instanceName = g.name?.toString() ?? "current";
        const handle = await context.writeResource(
          "state",
          instanceName,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    get: {
      description: "Get a ECS ExpressGatewayService",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS ExpressGatewayService",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const result = await readResource(
          "AWS::ECS::ExpressGatewayService",
          args.identifier,
        ) as StateData;
        const instanceName = context.globalArgs.name?.toString() ??
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
      description: "Update a ECS ExpressGatewayService",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.name?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.ServiceArn?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        const currentState = await readResource(
          "AWS::ECS::ExpressGatewayService",
          identifier,
        ) as StateData;
        const desiredState: Record<string, unknown> = { ...currentState };
        for (const [key, value] of Object.entries(g)) {
          if (key === "name") continue;
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await updateResource(
          "AWS::ECS::ExpressGatewayService",
          identifier,
          currentState,
          desiredState,
          ["ServiceName", "Cluster", "InfrastructureRoleArn", "Tags"],
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
      description: "Delete a ECS ExpressGatewayService",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS ExpressGatewayService",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const { existed } = await deleteResource(
          "AWS::ECS::ExpressGatewayService",
          args.identifier,
        );
        const instanceName = context.globalArgs.name?.toString() ??
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
      description: "Sync ECS ExpressGatewayService state from AWS",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.name?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.ServiceArn?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        try {
          const result = await readResource(
            "AWS::ECS::ExpressGatewayService",
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

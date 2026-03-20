// Auto-generated extension model for @swamp/aws/ecs/task-set
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

export const LoadBalancerSchema = z.object({
  TargetGroupArn: z.string().describe(
    "The full Amazon Resource Name (ARN) of the Elastic Load Balancing target group or groups associated with a service or task set. A target group ARN is only specified when using an Application Load Balancer or Network Load Balancer. If you are using a Classic Load Balancer this should be omitted. For services using the ECS deployment controller, you can specify one or multiple target groups. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/register-multiple-targetgroups.html in the Amazon Elastic Container Service Developer Guide. For services using the CODE_DEPLOY deployment controller, you are required to define two target groups for the load balancer. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-bluegreen.html in the Amazon Elastic Container Service Developer Guide. If your service's task definition uses the awsvpc network mode (which is required for the Fargate launch type), you must choose ip as the target type, not instance, when creating your target groups because tasks that use the awsvpc network mode are associated with an elastic network interface, not an Amazon EC2 instance.",
  ).optional(),
  ContainerName: z.string().describe(
    "The name of the container (as it appears in a container definition) to associate with the load balancer.",
  ).optional(),
  ContainerPort: z.number().int().describe(
    "The port on the container to associate with the load balancer. This port must correspond to a containerPort in the task definition the tasks in the service are using. For tasks that use the EC2 launch type, the container instance they are launched on must allow ingress traffic on the hostPort of the port mapping.",
  ).optional(),
});

export const ServiceRegistrySchema = z.object({
  ContainerName: z.string().describe(
    "The container name value, already specified in the task definition, to be used for your service discovery service. If the task definition that your service task specifies uses the bridge or host network mode, you must specify a containerName and containerPort combination from the task definition. If the task definition that your service task specifies uses the awsvpc network mode and a type SRV DNS record is used, you must specify either a containerName and containerPort combination or a port value, but not both.",
  ).optional(),
  Port: z.number().int().describe(
    "The port value used if your service discovery service specified an SRV record. This field may be used if both the awsvpc network mode and SRV records are used.",
  ).optional(),
  ContainerPort: z.number().int().describe(
    "The port value, already specified in the task definition, to be used for your service discovery service. If the task definition your service task specifies uses the bridge or host network mode, you must specify a containerName and containerPort combination from the task definition. If the task definition your service task specifies uses the awsvpc network mode and a type SRV DNS record is used, you must specify either a containerName and containerPort combination or a port value, but not both.",
  ).optional(),
  RegistryArn: z.string().describe(
    "The Amazon Resource Name (ARN) of the service registry. The currently supported service registry is AWS Cloud Map. For more information, see https://docs.aws.amazon.com/cloud-map/latest/api/API_CreateService.html",
  ).optional(),
});

export const CapacityProviderStrategyItemSchema = z.object({
  CapacityProvider: z.string().optional(),
  Base: z.number().int().optional(),
  Weight: z.number().int().optional(),
});

export const AwsVpcConfigurationSchema = z.object({
  SecurityGroups: z.array(z.string()).describe(
    "The security groups associated with the task or service. If you do not specify a security group, the default security group for the VPC is used. There is a limit of 5 security groups that can be specified per AwsVpcConfiguration.",
  ).optional(),
  Subnets: z.array(z.string()).describe(
    "The subnets associated with the task or service. There is a limit of 16 subnets that can be specified per AwsVpcConfiguration.",
  ),
  AssignPublicIp: z.enum(["DISABLED", "ENABLED"]).describe(
    "Whether the task's elastic network interface receives a public IP address. The default value is DISABLED.",
  ).optional(),
});

export const TagSchema = z.object({
  Value: z.string().optional(),
  Key: z.string().optional(),
});

const GlobalArgsSchema = z.object({
  name: z.string().describe(
    "Instance name for this resource (used as the unique identifier in the factory pattern)",
  ),
  PlatformVersion: z.string().describe(
    "The platform version that the tasks in the task set should use. A platform version is specified only for tasks using the Fargate launch type. If one isn't specified, the LATEST platform version is used by default.",
  ).optional(),
  ExternalId: z.string().describe(
    "An optional non-unique tag that identifies this task set in external systems. If the task set is associated with a service discovery registry, the tasks in this task set will have the ECS_TASK_SET_EXTERNAL_ID AWS Cloud Map attribute set to the provided value.",
  ).optional(),
  Cluster: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the cluster that hosts the service to create the task set in.",
  ),
  LoadBalancers: z.array(LoadBalancerSchema).optional(),
  Service: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the service to create the task set in.",
  ),
  Scale: z.object({
    Value: z.number().min(0).max(100).describe(
      "The value, specified as a percent total of a service's desiredCount, to scale the task set. Accepted values are numbers between 0 and 100.",
    ).optional(),
    Unit: z.enum(["PERCENT"]).describe(
      "The unit of measure for the scale value.",
    ).optional(),
  }).describe(
    "A floating-point percentage of the desired number of tasks to place and keep running in the task set.",
  ).optional(),
  ServiceRegistries: z.array(ServiceRegistrySchema).describe(
    "The details of the service discovery registries to assign to this task set. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html.",
  ).optional(),
  CapacityProviderStrategy: z.array(CapacityProviderStrategyItemSchema)
    .optional(),
  LaunchType: z.enum(["EC2", "FARGATE"]).describe(
    "The launch type that new tasks in the task set will use. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_types.html in the Amazon Elastic Container Service Developer Guide.",
  ).optional(),
  TaskDefinition: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the task definition for the tasks in the task set to use.",
  ),
  NetworkConfiguration: z.object({
    AwsVpcConfiguration: AwsVpcConfigurationSchema.describe(
      "The VPC subnets and security groups associated with a task. All specified subnets and security groups must be from the same VPC.",
    ).optional(),
  }).describe(
    "An object representing the network configuration for a task or service.",
  ).optional(),
  Tags: z.array(TagSchema).optional(),
});

const StateSchema = z.object({
  PlatformVersion: z.string().optional(),
  ExternalId: z.string().optional(),
  Cluster: z.string(),
  LoadBalancers: z.array(LoadBalancerSchema).optional(),
  Service: z.string(),
  Scale: z.object({
    Value: z.number(),
    Unit: z.string(),
  }).optional(),
  ServiceRegistries: z.array(ServiceRegistrySchema).optional(),
  CapacityProviderStrategy: z.array(CapacityProviderStrategyItemSchema)
    .optional(),
  LaunchType: z.string().optional(),
  TaskDefinition: z.string().optional(),
  NetworkConfiguration: z.object({
    AwsVpcConfiguration: AwsVpcConfigurationSchema,
  }).optional(),
  Id: z.string(),
  Tags: z.array(TagSchema).optional(),
}).passthrough();

type StateData = z.infer<typeof StateSchema>;

const InputsSchema = z.object({
  name: z.string().optional(),
  PlatformVersion: z.string().describe(
    "The platform version that the tasks in the task set should use. A platform version is specified only for tasks using the Fargate launch type. If one isn't specified, the LATEST platform version is used by default.",
  ).optional(),
  ExternalId: z.string().describe(
    "An optional non-unique tag that identifies this task set in external systems. If the task set is associated with a service discovery registry, the tasks in this task set will have the ECS_TASK_SET_EXTERNAL_ID AWS Cloud Map attribute set to the provided value.",
  ).optional(),
  Cluster: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the cluster that hosts the service to create the task set in.",
  ).optional(),
  LoadBalancers: z.array(LoadBalancerSchema).optional(),
  Service: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the service to create the task set in.",
  ).optional(),
  Scale: z.object({
    Value: z.number().min(0).max(100).describe(
      "The value, specified as a percent total of a service's desiredCount, to scale the task set. Accepted values are numbers between 0 and 100.",
    ).optional(),
    Unit: z.enum(["PERCENT"]).describe(
      "The unit of measure for the scale value.",
    ).optional(),
  }).describe(
    "A floating-point percentage of the desired number of tasks to place and keep running in the task set.",
  ).optional(),
  ServiceRegistries: z.array(ServiceRegistrySchema).describe(
    "The details of the service discovery registries to assign to this task set. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html.",
  ).optional(),
  CapacityProviderStrategy: z.array(CapacityProviderStrategyItemSchema)
    .optional(),
  LaunchType: z.enum(["EC2", "FARGATE"]).describe(
    "The launch type that new tasks in the task set will use. For more information, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_types.html in the Amazon Elastic Container Service Developer Guide.",
  ).optional(),
  TaskDefinition: z.string().describe(
    "The short name or full Amazon Resource Name (ARN) of the task definition for the tasks in the task set to use.",
  ).optional(),
  NetworkConfiguration: z.object({
    AwsVpcConfiguration: AwsVpcConfigurationSchema.describe(
      "The VPC subnets and security groups associated with a task. All specified subnets and security groups must be from the same VPC.",
    ).optional(),
  }).describe(
    "An object representing the network configuration for a task or service.",
  ).optional(),
  Tags: z.array(TagSchema).optional(),
});

export const model = {
  type: "@swamp/aws/ecs/task-set",
  version: "2026.03.19.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: InputsSchema,
  resources: {
    state: {
      description: "ECS TaskSet resource state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a ECS TaskSet",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const desiredState: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(g)) {
          if (key === "name") continue;
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await createResource(
          "AWS::ECS::TaskSet",
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
      description: "Get a ECS TaskSet",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS TaskSet",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const result = await readResource(
          "AWS::ECS::TaskSet",
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
      description: "Update a ECS TaskSet",
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
        const idParts = [
          existing.Cluster?.toString(),
          existing.Service?.toString(),
          existing.Id?.toString(),
        ];
        if (idParts.some((p) => !p)) {
          throw new Error(
            "Missing primary identifier fields in existing state",
          );
        }
        const identifier = idParts.join("|");
        const currentState = await readResource(
          "AWS::ECS::TaskSet",
          identifier,
        ) as StateData;
        const desiredState: Record<string, unknown> = { ...currentState };
        for (const [key, value] of Object.entries(g)) {
          if (key === "name") continue;
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await updateResource(
          "AWS::ECS::TaskSet",
          identifier,
          currentState,
          desiredState,
          [
            "Cluster",
            "ExternalId",
            "LaunchType",
            "LoadBalancers",
            "NetworkConfiguration",
            "PlatformVersion",
            "Service",
            "ServiceRegistries",
            "TaskDefinition",
            "CapacityProviderStrategy",
          ],
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
      description: "Delete a ECS TaskSet",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS TaskSet",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const { existed } = await deleteResource(
          "AWS::ECS::TaskSet",
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
      description: "Sync ECS TaskSet state from AWS",
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
        const idParts = [
          existing.Cluster?.toString(),
          existing.Service?.toString(),
          existing.Id?.toString(),
        ];
        if (idParts.some((p) => !p)) {
          throw new Error(
            "Missing primary identifier fields in existing state",
          );
        }
        const identifier = idParts.join("|");
        try {
          const result = await readResource(
            "AWS::ECS::TaskSet",
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

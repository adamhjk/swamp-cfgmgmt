// Auto-generated extension model for @swamp/aws/ecs/capacity-provider
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

export const ManagedScalingSchema = z.object({
  Status: z.enum(["DISABLED", "ENABLED"]).optional(),
  MinimumScalingStepSize: z.number().int().optional(),
  InstanceWarmupPeriod: z.number().int().optional(),
  TargetCapacity: z.number().int().optional(),
  MaximumScalingStepSize: z.number().int().optional(),
});

export const TagSchema = z.object({
  Value: z.string().min(1).optional(),
  Key: z.string().min(1).optional(),
});

export const ManagedInstancesStorageConfigurationSchema = z.object({
  StorageSizeGiB: z.number().int(),
});

export const ManagedInstancesNetworkConfigurationSchema = z.object({
  SecurityGroups: z.array(z.string()),
  Subnets: z.array(z.string()),
});

export const NetworkInterfaceCountRequestSchema = z.object({
  Min: z.number().int().optional(),
  Max: z.number().int().optional(),
});

export const MemoryGiBPerVCpuRequestSchema = z.object({
  Min: z.number().optional(),
  Max: z.number().optional(),
});

export const VCpuCountRangeRequestSchema = z.object({
  Min: z.number().int(),
  Max: z.number().int().optional(),
});

export const NetworkBandwidthGbpsRequestSchema = z.object({
  Min: z.number().optional(),
  Max: z.number().optional(),
});

export const AcceleratorCountRequestSchema = z.object({
  Min: z.number().int().optional(),
  Max: z.number().int().optional(),
});

export const BaselineEbsBandwidthMbpsRequestSchema = z.object({
  Min: z.number().int().optional(),
  Max: z.number().int().optional(),
});

export const AcceleratorTotalMemoryMiBRequestSchema = z.object({
  Min: z.number().int().optional(),
  Max: z.number().int().optional(),
});

export const MemoryMiBRequestSchema = z.object({
  Min: z.number().int(),
  Max: z.number().int().optional(),
});

export const TotalLocalStorageGBRequestSchema = z.object({
  Min: z.number().optional(),
  Max: z.number().optional(),
});

export const InstanceRequirementsRequestSchema = z.object({
  LocalStorageTypes: z.array(z.enum(["hdd", "ssd"])).optional(),
  InstanceGenerations: z.array(z.enum(["current", "previous"])).optional(),
  NetworkInterfaceCount: NetworkInterfaceCountRequestSchema.optional(),
  MemoryGiBPerVCpu: MemoryGiBPerVCpuRequestSchema.optional(),
  AcceleratorTypes: z.array(z.enum(["gpu", "fpga", "inference"])).optional(),
  VCpuCount: VCpuCountRangeRequestSchema,
  ExcludedInstanceTypes: z.array(
    z.string().min(1).max(30).regex(new RegExp("[a-zA-Z0-9\\.\\*]+")),
  ).optional(),
  AcceleratorManufacturers: z.array(
    z.enum(["amazon-web-services", "amd", "habana", "nvidia", "xilinx"]),
  ).optional(),
  AllowedInstanceTypes: z.array(
    z.string().min(1).max(30).regex(new RegExp("[a-zA-Z0-9\\.\\*]+")),
  ).optional(),
  LocalStorage: z.enum(["included", "required", "excluded"]).optional(),
  CpuManufacturers: z.array(z.enum(["intel", "amd", "amazon-web-services"]))
    .optional(),
  NetworkBandwidthGbps: NetworkBandwidthGbpsRequestSchema.optional(),
  AcceleratorCount: AcceleratorCountRequestSchema.optional(),
  BareMetal: z.enum(["included", "required", "excluded"]).optional(),
  RequireHibernateSupport: z.boolean().optional(),
  MaxSpotPriceAsPercentageOfOptimalOnDemandPrice: z.number().int().optional(),
  SpotMaxPricePercentageOverLowestPrice: z.number().int().optional(),
  BaselineEbsBandwidthMbps: BaselineEbsBandwidthMbpsRequestSchema.optional(),
  OnDemandMaxPricePercentageOverLowestPrice: z.number().int().optional(),
  AcceleratorNames: z.array(
    z.enum([
      "a10g",
      "a100",
      "h100",
      "inferentia",
      "k520",
      "k80",
      "m60",
      "radeon-pro-v520",
      "t4",
      "t4g",
      "vu9p",
      "v100",
      "l40s",
    ]),
  ).optional(),
  AcceleratorTotalMemoryMiB: AcceleratorTotalMemoryMiBRequestSchema.optional(),
  BurstablePerformance: z.enum(["included", "required", "excluded"]).optional(),
  MemoryMiB: MemoryMiBRequestSchema,
  TotalLocalStorageGB: TotalLocalStorageGBRequestSchema.optional(),
});

export const CapacityReservationRequestSchema = z.object({
  ReservationGroupArn: z.string().optional(),
  ReservationPreference: z.enum([
    "RESERVATIONS_ONLY",
    "RESERVATIONS_FIRST",
    "RESERVATIONS_EXCLUDED",
  ]).optional(),
});

export const InstanceLaunchTemplateSchema = z.object({
  Ec2InstanceProfileArn: z.string(),
  CapacityOptionType: z.enum(["ON_DEMAND", "SPOT", "RESERVED"]).optional(),
  FipsEnabled: z.boolean().optional(),
  InstanceMetadataTagsPropagation: z.boolean().optional(),
  StorageConfiguration: ManagedInstancesStorageConfigurationSchema.optional(),
  NetworkConfiguration: ManagedInstancesNetworkConfigurationSchema,
  InstanceRequirements: InstanceRequirementsRequestSchema.optional(),
  CapacityReservations: CapacityReservationRequestSchema.optional(),
  Monitoring: z.enum(["BASIC", "DETAILED"]).optional(),
});

const GlobalArgsSchema = z.object({
  AutoScalingGroupProvider: z.object({
    ManagedScaling: ManagedScalingSchema.describe(
      "The managed scaling settings for the Auto Scaling group capacity provider.",
    ).optional(),
    AutoScalingGroupArn: z.string(),
    ManagedTerminationProtection: z.enum(["DISABLED", "ENABLED"]).optional(),
    ManagedDraining: z.enum(["DISABLED", "ENABLED"]).optional(),
  }).optional(),
  ClusterName: z.string().optional(),
  Tags: z.array(TagSchema).optional(),
  Name: z.string().optional(),
  ManagedInstancesProvider: z.object({
    InfrastructureRoleArn: z.string(),
    PropagateTags: z.enum(["CAPACITY_PROVIDER", "NONE"]).optional(),
    InfrastructureOptimization: z.object({
      ScaleInAfter: z.number().int().min(-1).max(3600).describe(
        "This parameter defines the number of seconds Amazon ECS Managed Instances waits before optimizing EC2 instances that have become idle or underutilized. A longer delay increases the likelihood of placing new tasks on idle instances, reducing startup time. A shorter delay helps reduce infrastructure costs by optimizing idle instances more quickly. Valid values are: Not set (null) - Uses the default optimization behavior, `-1` - Disables automatic infrastructure optimization, `0` to `3600` (inclusive) - Specifies the number of seconds to wait before optimizing instances.",
      ).optional(),
    }).describe(
      "Defines how Amazon ECS Managed Instances optimizes the infrastructure in your capacity provider. Configure it to turn on or off the infrastructure optimization in your capacity provider, and to control the idle EC2 instances optimization delay.",
    ).optional(),
    InstanceLaunchTemplate: InstanceLaunchTemplateSchema,
  }).optional(),
});

const StateSchema = z.object({
  AutoScalingGroupProvider: z.object({
    ManagedScaling: ManagedScalingSchema,
    AutoScalingGroupArn: z.string(),
    ManagedTerminationProtection: z.string(),
    ManagedDraining: z.string(),
  }).optional(),
  ClusterName: z.string().optional(),
  Tags: z.array(TagSchema).optional(),
  Name: z.string(),
  ManagedInstancesProvider: z.object({
    InfrastructureRoleArn: z.string(),
    PropagateTags: z.string(),
    InfrastructureOptimization: z.object({
      ScaleInAfter: z.number(),
    }),
    InstanceLaunchTemplate: InstanceLaunchTemplateSchema,
  }).optional(),
}).passthrough();

type StateData = z.infer<typeof StateSchema>;

const InputsSchema = z.object({
  AutoScalingGroupProvider: z.object({
    ManagedScaling: ManagedScalingSchema.describe(
      "The managed scaling settings for the Auto Scaling group capacity provider.",
    ).optional(),
    AutoScalingGroupArn: z.string().optional(),
    ManagedTerminationProtection: z.enum(["DISABLED", "ENABLED"]).optional(),
    ManagedDraining: z.enum(["DISABLED", "ENABLED"]).optional(),
  }).optional(),
  ClusterName: z.string().optional(),
  Tags: z.array(TagSchema).optional(),
  Name: z.string().optional(),
  ManagedInstancesProvider: z.object({
    InfrastructureRoleArn: z.string().optional(),
    PropagateTags: z.enum(["CAPACITY_PROVIDER", "NONE"]).optional(),
    InfrastructureOptimization: z.object({
      ScaleInAfter: z.number().int().min(-1).max(3600).describe(
        "This parameter defines the number of seconds Amazon ECS Managed Instances waits before optimizing EC2 instances that have become idle or underutilized. A longer delay increases the likelihood of placing new tasks on idle instances, reducing startup time. A shorter delay helps reduce infrastructure costs by optimizing idle instances more quickly. Valid values are: Not set (null) - Uses the default optimization behavior, `-1` - Disables automatic infrastructure optimization, `0` to `3600` (inclusive) - Specifies the number of seconds to wait before optimizing instances.",
      ).optional(),
    }).describe(
      "Defines how Amazon ECS Managed Instances optimizes the infrastructure in your capacity provider. Configure it to turn on or off the infrastructure optimization in your capacity provider, and to control the idle EC2 instances optimization delay.",
    ).optional(),
    InstanceLaunchTemplate: InstanceLaunchTemplateSchema.optional(),
  }).optional(),
});

export const model = {
  type: "@swamp/aws/ecs/capacity-provider",
  version: "2026.03.25.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: InputsSchema,
  resources: {
    state: {
      description: "ECS CapacityProvider resource state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a ECS CapacityProvider",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const desiredState: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(g)) {
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await createResource(
          "AWS::ECS::CapacityProvider",
          desiredState,
        ) as StateData;
        const instanceName = (result.Name ?? g.Name)?.toString() ?? "current";
        const handle = await context.writeResource(
          "state",
          instanceName,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
    get: {
      description: "Get a ECS CapacityProvider",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS CapacityProvider",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const result = await readResource(
          "AWS::ECS::CapacityProvider",
          args.identifier,
        ) as StateData;
        const instanceName =
          (result.Name ?? context.globalArgs.Name)?.toString() ??
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
      description: "Update a ECS CapacityProvider",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.Name?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.Name?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        const currentState = await readResource(
          "AWS::ECS::CapacityProvider",
          identifier,
        ) as StateData;
        const desiredState: Record<string, unknown> = { ...currentState };
        for (const [key, value] of Object.entries(g)) {
          if (value !== undefined) desiredState[key] = value;
        }
        const result = await updateResource(
          "AWS::ECS::CapacityProvider",
          identifier,
          currentState,
          desiredState,
          ["AutoScalingGroupArn", "FipsEnabled", "Name", "ClusterName"],
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
      description: "Delete a ECS CapacityProvider",
      arguments: z.object({
        identifier: z.string().describe(
          "The primary identifier of the ECS CapacityProvider",
        ),
      }),
      execute: async (args: { identifier: string }, context: any) => {
        const { existed } = await deleteResource(
          "AWS::ECS::CapacityProvider",
          args.identifier,
        );
        const instanceName = context.globalArgs.Name?.toString() ??
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
      description: "Sync ECS CapacityProvider state from AWS",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: any) => {
        const g = context.globalArgs;
        const instanceName = g.Name?.toString() ?? "current";
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          instanceName,
        );
        if (!content) {
          throw new Error("No existing state found - run create or get first");
        }
        const existing = JSON.parse(new TextDecoder().decode(content));
        const identifier = existing.Name?.toString();
        if (!identifier) {
          throw new Error("No identifier found in existing state");
        }
        try {
          const result = await readResource(
            "AWS::ECS::CapacityProvider",
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

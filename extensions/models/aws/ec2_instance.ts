import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  region: z.string().default("us-east-1"),
  instanceType: z.string().default("t3.micro"),
  awsProfile: z.string().optional(),
});

const InstanceSchema = z.object({
  InstanceId: z.string(),
  PublicIpAddress: z.string().optional(),
  PrivateIpAddress: z.string().optional(),
  KeyName: z.string(),
  SecurityGroupId: z.string(),
  State: z.string(),
}).passthrough();

const KeypairSchema = z.object({
  KeyName: z.string(),
  KeyPairId: z.string(),
  KeyMaterial: z.string().meta({ sensitive: true }),
  KeyFilePath: z.string(),
});

async function awsCli(
  args: string[],
  globalArgs: { region: string; awsProfile?: string },
) {
  const fullArgs = [...args, "--region", globalArgs.region, "--output", "json"];
  if (globalArgs.awsProfile) {
    fullArgs.push("--profile", globalArgs.awsProfile);
  }
  const cmd = new Deno.Command("aws", {
    args: fullArgs,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`AWS CLI failed: ${stderr.trim()}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

async function validateCredentials(
  globalArgs: { region: string; awsProfile?: string },
) {
  const fullArgs = [
    "sts",
    "get-caller-identity",
    "--region",
    globalArgs.region,
    "--output",
    "json",
  ];
  if (globalArgs.awsProfile) {
    fullArgs.push("--profile", globalArgs.awsProfile);
  }
  const cmd = new Deno.Command("aws", {
    args: fullArgs,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    const profileHint = globalArgs.awsProfile
      ? `\n  aws sso login --profile ${globalArgs.awsProfile}`
      : "";
    throw new Error(
      `AWS credential check failed: ${stderr.trim()}\n\n` +
        `Ensure your credentials are valid.${profileHint}`,
    );
  }
}

async function getLatestAmazonLinuxAmi(
  globalArgs: { region: string; awsProfile?: string },
) {
  const result = await awsCli([
    "ec2",
    "describe-images",
    "--owners",
    "amazon",
    "--filters",
    "Name=name,Values=al2023-ami-2023*-x86_64",
    "Name=state,Values=available",
    "--query",
    "sort_by(Images, &CreationDate)[-1].ImageId",
  ], globalArgs);
  if (!result) {
    throw new Error("Could not find Amazon Linux 2023 AMI in the region");
  }
  return result;
}

const InputsSchema = z.object({
  machineId: z.string().describe("Unique identifier for this machine instance"),
});

export const model = {
  type: "@user/ec2-instance",
  version: "2026.03.02.2",
  globalArguments: GlobalArgsSchema,
  inputsSchema: InputsSchema,
  resources: {
    "instance": {
      description: "EC2 instance state",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "keypair": {
      description: "SSH key pair",
      schema: KeypairSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description:
        "Create an EC2 instance with SSH access (key pair + security group + instance)",
      arguments: z.object({
        machineId: z.string().describe(
          "Unique identifier for this machine instance",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { region, instanceType, awsProfile } = context.globalArgs;
        const name = context.definition.name;
        const machineId = args.machineId;

        await validateCredentials({ region, awsProfile });

        context.logger.info("Looking up latest Amazon Linux 2023 AMI");
        const amiId = await getLatestAmazonLinuxAmi({ region, awsProfile });
        context.logger.info("Using AMI {ami}", { ami: amiId });

        // Create key pair
        const keyName = `${name}-${machineId}-key`;
        context.logger.info("Creating key pair {keyName}", { keyName });
        const keyPairResult = await awsCli([
          "ec2",
          "create-key-pair",
          "--key-name",
          keyName,
          "--key-type",
          "ed25519",
        ], { region, awsProfile });

        // Write private key to a temp file for SSH access
        const keyDir = `${context.repoDir}/.swamp/keys`;
        try {
          await Deno.mkdir(keyDir, { recursive: true });
        } catch { /* exists */ }
        const keyFilePath = `${keyDir}/${keyName}.pem`;
        await Deno.writeTextFile(keyFilePath, keyPairResult.KeyMaterial);
        await Deno.chmod(keyFilePath, 0o600);

        const keypairHandle = await context.writeResource(
          "keypair",
          "keypair-" + machineId,
          {
            KeyName: keyPairResult.KeyName,
            KeyPairId: keyPairResult.KeyPairId,
            KeyMaterial: keyPairResult.KeyMaterial,
            KeyFilePath: keyFilePath,
          },
        );

        // Create security group
        const sgName = `${name}-${machineId}-sg`;
        context.logger.info("Creating security group {sgName}", { sgName });

        // Get default VPC
        const vpcs = await awsCli([
          "ec2",
          "describe-vpcs",
          "--filters",
          "Name=isDefault,Values=true",
        ], { region, awsProfile });
        const vpcId = vpcs.Vpcs?.[0]?.VpcId;
        if (!vpcId) {
          throw new Error("No default VPC found in region " + region);
        }

        const sgResult = await awsCli([
          "ec2",
          "create-security-group",
          "--group-name",
          sgName,
          "--description",
          `SSH access for ${name}-${machineId}`,
          "--vpc-id",
          vpcId,
        ], { region, awsProfile });
        const sgId = sgResult.GroupId;

        // Authorize SSH inbound
        context.logger.info(
          "Authorizing SSH ingress on security group {sgId}",
          { sgId },
        );
        await awsCli([
          "ec2",
          "authorize-security-group-ingress",
          "--group-id",
          sgId,
          "--protocol",
          "tcp",
          "--port",
          "22",
          "--cidr",
          "0.0.0.0/0",
        ], { region, awsProfile });

        // Launch instance
        context.logger.info("Launching {type} instance with AMI {ami}", {
          type: instanceType,
          ami: amiId,
        });
        const runResult = await awsCli([
          "ec2",
          "run-instances",
          "--image-id",
          amiId,
          "--instance-type",
          instanceType,
          "--key-name",
          keyName,
          "--security-group-ids",
          sgId,
          "--count",
          "1",
          "--tag-specifications",
          `ResourceType=instance,Tags=[{Key=Name,Value=${name}-${machineId}}]`,
        ], { region, awsProfile });

        const instanceId = runResult.Instances[0].InstanceId;
        context.logger.info(
          "Instance {id} launched, waiting for running state",
          { id: instanceId },
        );

        // Wait for instance to be running
        const waitArgs = [
          "ec2",
          "wait",
          "instance-running",
          "--instance-ids",
          instanceId,
          "--region",
          region,
          "--output",
          "json",
        ];
        if (awsProfile) waitArgs.push("--profile", awsProfile);
        const waitCmd = new Deno.Command("aws", {
          args: waitArgs,
          stdout: "piped",
          stderr: "piped",
        });
        const waitOutput = await waitCmd.output();
        if (waitOutput.code !== 0) {
          throw new Error(
            "Timed out waiting for instance to reach running state",
          );
        }

        // Describe instance to get public IP
        const describeResult = await awsCli([
          "ec2",
          "describe-instances",
          "--instance-ids",
          instanceId,
        ], { region, awsProfile });
        const instance = describeResult.Reservations[0].Instances[0];

        const instanceHandle = await context.writeResource(
          "instance",
          "instance-" + machineId,
          {
            InstanceId: instance.InstanceId,
            PublicIpAddress: instance.PublicIpAddress,
            PrivateIpAddress: instance.PrivateIpAddress,
            KeyName: keyName,
            SecurityGroupId: sgId,
            State: instance.State.Name,
          },
        );

        context.logger.info("Instance {id} is running at {ip}", {
          id: instance.InstanceId,
          ip: instance.PublicIpAddress,
        });
        context.logger.info("SSH: ssh -i {keyFile} ec2-user@{ip}", {
          keyFile: keyFilePath,
          ip: instance.PublicIpAddress,
        });

        return { dataHandles: [instanceHandle, keypairHandle] };
      },
    },
    terminate: {
      description:
        "Terminate the EC2 instance and clean up key pair and security group",
      arguments: z.object({
        machineId: z.string().describe(
          "Unique identifier for this machine instance",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const { region, awsProfile } = context.globalArgs;
        const machineId = args.machineId;

        await validateCredentials({ region, awsProfile });

        // Read instance state
        const instanceContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "instance-" + machineId,
        );
        if (!instanceContent) {
          throw new Error(
            `No instance data found for machine ${machineId} - nothing to terminate`,
          );
        }
        const instanceData = JSON.parse(
          new TextDecoder().decode(instanceContent),
        );

        // Read keypair state
        const keypairContent = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "keypair-" + machineId,
        );

        // Terminate instance
        context.logger.info("Terminating instance {id}", {
          id: instanceData.InstanceId,
        });
        await awsCli([
          "ec2",
          "terminate-instances",
          "--instance-ids",
          instanceData.InstanceId,
        ], { region, awsProfile });

        // Wait for termination
        context.logger.info("Waiting for instance to terminate");
        const waitArgs = [
          "ec2",
          "wait",
          "instance-terminated",
          "--instance-ids",
          instanceData.InstanceId,
          "--region",
          region,
          "--output",
          "json",
        ];
        if (awsProfile) waitArgs.push("--profile", awsProfile);
        const waitCmd = new Deno.Command("aws", {
          args: waitArgs,
          stdout: "piped",
          stderr: "piped",
        });
        await waitCmd.output();

        // Delete security group
        context.logger.info("Deleting security group {sg}", {
          sg: instanceData.SecurityGroupId,
        });
        try {
          await awsCli([
            "ec2",
            "delete-security-group",
            "--group-id",
            instanceData.SecurityGroupId,
          ], { region, awsProfile });
        } catch (err) {
          context.logger.warning("Could not delete security group: {error}", {
            error: String(err),
          });
        }

        // Delete key pair
        context.logger.info("Deleting key pair {key}", {
          key: instanceData.KeyName,
        });
        try {
          await awsCli([
            "ec2",
            "delete-key-pair",
            "--key-name",
            instanceData.KeyName,
          ], { region, awsProfile });
        } catch (err) {
          context.logger.warning("Could not delete key pair: {error}", {
            error: String(err),
          });
        }

        // Clean up local key file
        if (keypairContent) {
          const kpData = JSON.parse(new TextDecoder().decode(keypairContent));
          if (kpData.KeyFilePath) {
            try {
              await Deno.remove(kpData.KeyFilePath);
              context.logger.info("Removed local key file {path}", {
                path: kpData.KeyFilePath,
              });
            } catch { /* already gone */ }
          }
        }

        context.logger.info(
          "All resources for machine {machineId} cleaned up",
          { machineId },
        );
        return { dataHandles: [] };
      },
    },
  },
};

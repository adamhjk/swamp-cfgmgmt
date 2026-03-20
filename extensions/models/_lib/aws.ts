// Auto-generated shared helper for AWS CloudControl extension models.
// Do not edit manually. Re-generate with: deno task generate:aws

import {
  CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  UpdateResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import jsonpatch from "fast-json-patch";

function createClient(): CloudControlClient {
  return new CloudControlClient({
    region: Deno.env.get("AWS_REGION") || "us-east-1",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlingError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  return (
    msg.includes("Throttling") ||
    msg.includes("TooManyRequests") ||
    msg.includes("RequestLimitExceeded") ||
    name === "ThrottlingException"
  );
}

export function isResourceNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  return (
    msg.includes("was not found") ||
    msg.includes("does not exist") ||
    name === "ResourceNotFoundException"
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxAttempts = 20,
): Promise<T> {
  const baseDelay = 1000;
  const maxDelay = 90000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isThrottlingError(error) && attempt < maxAttempts - 1) {
        const exponentialDelay = Math.min(
          baseDelay * Math.pow(2, attempt),
          maxDelay,
        );
        const jitter = Math.random() * 0.3 * exponentialDelay;
        console.log(
          `[${operationName}] Throttled on attempt ${attempt + 1}, waiting ${
            Math.round(exponentialDelay + jitter)
          }ms`,
        );
        await delay(exponentialDelay + jitter);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

async function pollOperationStatus(
  client: CloudControlClient,
  requestToken: string,
  operationName: string,
): Promise<{ status: string; identifier?: string; message?: string }> {
  const baseDelay = 1000;
  const maxDelay = 90000;

  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await withRetry(
      () =>
        client.send(
          new GetResourceRequestStatusCommand({
            RequestToken: requestToken,
          }),
        ),
      `${operationName} status poll`,
    );

    const status = response.ProgressEvent?.OperationStatus;
    if (status === "SUCCESS") {
      return {
        status: "SUCCESS",
        identifier: response.ProgressEvent?.Identifier,
      };
    }
    if (status === "FAILED") {
      return {
        status: "FAILED",
        message: response.ProgressEvent?.StatusMessage ||
          response.ProgressEvent?.ErrorCode,
      };
    }
    if (status === "CANCEL_COMPLETE") {
      return {
        status: "CANCEL_COMPLETE",
        message: "Operation cancelled by API or AWS",
      };
    }

    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt),
      maxDelay,
    );
    const jitter = Math.random() * 0.3 * exponentialDelay;
    console.log(
      `[${operationName}] IN_PROGRESS, waiting ${
        Math.round(exponentialDelay + jitter)
      }ms (poll ${attempt + 1})`,
    );
    await delay(exponentialDelay + jitter);
  }

  throw new Error(`${operationName} timed out after polling`);
}

/**
 * Create an AWS resource via CloudControl API.
 * Sends CreateResourceCommand, polls until complete, then reads the resource.
 * Returns the resource properties.
 */
export async function createResource(
  typeName: string,
  desiredState: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = createClient();

  console.log(`[CREATE] Starting create for ${typeName}`);

  const response = await withRetry(
    () =>
      client.send(
        new CreateResourceCommand({
          TypeName: typeName,
          DesiredState: JSON.stringify(desiredState),
        }),
      ),
    `${typeName} create`,
  );

  if (!response.ProgressEvent?.RequestToken) {
    throw new Error(`${typeName} creation failed: no request token returned`);
  }

  const requestToken = response.ProgressEvent.RequestToken;
  console.log(`[CREATE] Got request token: ${requestToken}`);

  const pollResult = await pollOperationStatus(
    client,
    requestToken,
    `${typeName} create`,
  );

  if (pollResult.status === "FAILED") {
    throw new Error(
      `${typeName} creation failed: ${pollResult.message || "Unknown error"}`,
    );
  }
  if (pollResult.status === "CANCEL_COMPLETE") {
    throw new Error(
      `${typeName} creation cancelled: ${pollResult.message}`,
    );
  }

  const identifier = pollResult.identifier;
  if (!identifier) {
    throw new Error(
      `${typeName} creation succeeded but no identifier returned`,
    );
  }

  console.log(`[CREATE] Success, fetching resource ${identifier}`);

  const getResponse = await withRetry(
    () =>
      client.send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        }),
      ),
    `${typeName} create get-resource`,
  );

  if (!getResponse.ResourceDescription?.Properties) {
    throw new Error(`Failed to get ${typeName} details after creation`);
  }

  return JSON.parse(getResponse.ResourceDescription.Properties);
}

/**
 * Read an AWS resource via CloudControl API.
 * Returns the resource properties, or throws if not found.
 */
export async function readResource(
  typeName: string,
  identifier: string,
): Promise<Record<string, unknown>> {
  const client = createClient();

  console.log(`[READ] Fetching ${typeName} identifier: ${identifier}`);

  const response = await withRetry(
    () =>
      client.send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        }),
      ),
    `${typeName} read`,
  );

  if (!response.ResourceDescription?.Properties) {
    throw new Error(`Failed to get ${typeName} details`);
  }

  return JSON.parse(response.ResourceDescription.Properties);
}

/**
 * Update an AWS resource via CloudControl API.
 * Reads current state, computes JSON patch (filtering createOnlyProperties),
 * sends UpdateResourceCommand, polls, then reads the updated resource.
 */
export async function updateResource(
  typeName: string,
  identifier: string,
  currentState: Record<string, unknown>,
  desiredState: Record<string, unknown>,
  createOnlyProperties?: string[],
): Promise<Record<string, unknown>> {
  const client = createClient();
  const createOnlySet = new Set(createOnlyProperties ?? []);

  console.log(
    `[UPDATE] Starting update for ${typeName} identifier: ${identifier}`,
  );

  // Compute JSON patch, filtering out create-only properties
  const rawPatch = jsonpatch.compare(currentState, desiredState);
  const patch = rawPatch.filter((op: { path: string }) => {
    const topLevelProp = op.path.split("/")[1];
    if (topLevelProp && createOnlySet.has(topLevelProp)) {
      console.log(`[UPDATE] Skipping create-only property: ${topLevelProp}`);
      return false;
    }
    return true;
  });

  if (patch.length === 0) {
    console.log(`[UPDATE] No changes detected, returning current state`);
    return currentState;
  }

  console.log(`[UPDATE] Applying ${patch.length} patch operations`);

  const response = await withRetry(
    () =>
      client.send(
        new UpdateResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
          PatchDocument: JSON.stringify(patch),
        }),
      ),
    `${typeName} update`,
  );

  if (!response.ProgressEvent?.RequestToken) {
    throw new Error(`${typeName} update failed: no request token returned`);
  }

  const requestToken = response.ProgressEvent.RequestToken;
  console.log(`[UPDATE] Got request token: ${requestToken}`);

  const pollResult = await pollOperationStatus(
    client,
    requestToken,
    `${typeName} update`,
  );

  if (pollResult.status === "FAILED") {
    throw new Error(
      `${typeName} update failed: ${pollResult.message || "Unknown error"}`,
    );
  }
  if (pollResult.status === "CANCEL_COMPLETE") {
    throw new Error(`${typeName} update cancelled: ${pollResult.message}`);
  }

  const resultIdentifier = pollResult.identifier || identifier;
  console.log(`[UPDATE] Success, fetching resource ${resultIdentifier}`);

  const getResponse = await withRetry(
    () =>
      client.send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: resultIdentifier,
        }),
      ),
    `${typeName} update get-resource`,
  );

  if (!getResponse.ResourceDescription?.Properties) {
    throw new Error(`Failed to get ${typeName} details after update`);
  }

  return JSON.parse(getResponse.ResourceDescription.Properties);
}

/**
 * Delete an AWS resource via CloudControl API.
 * Returns { existed: true } on success, { existed: false } if already gone.
 */
export async function deleteResource(
  typeName: string,
  identifier: string,
): Promise<{ existed: boolean }> {
  const client = createClient();

  console.log(
    `[DELETE] Starting delete for ${typeName} identifier: ${identifier}`,
  );

  try {
    const response = await withRetry(
      () =>
        client.send(
          new DeleteResourceCommand({
            TypeName: typeName,
            Identifier: identifier,
          }),
        ),
      `${typeName} delete`,
    );

    if (!response.ProgressEvent?.RequestToken) {
      throw new Error(`${typeName} deletion failed: no request token returned`);
    }

    const requestToken = response.ProgressEvent.RequestToken;
    console.log(`[DELETE] Got request token: ${requestToken}`);

    const pollResult = await pollOperationStatus(
      client,
      requestToken,
      `${typeName} delete`,
    );

    if (pollResult.status === "FAILED") {
      if (
        pollResult.message &&
        (pollResult.message.includes("was not found") ||
          pollResult.message.includes("does not exist"))
      ) {
        return { existed: false };
      }
      throw new Error(
        `${typeName} deletion failed: ${pollResult.message || "Unknown error"}`,
      );
    }

    if (pollResult.status === "CANCEL_COMPLETE") {
      throw new Error(
        `${typeName} deletion cancelled: ${pollResult.message}`,
      );
    }

    return { existed: true };
  } catch (error: unknown) {
    if (isResourceNotFoundError(error)) {
      return { existed: false };
    }
    throw error;
  }
}

// Shared utilities for @adam/cfgmgmt reports.

export const decoder = new TextDecoder();

export function typeString(modelType) {
  if (typeof modelType === "string") return modelType;
  if (modelType && typeof modelType === "object") {
    if (typeof modelType.raw === "string") return modelType.raw;
    if (typeof modelType.normalized === "string") return modelType.normalized;
  }
  return String(modelType);
}

export function asModelType(modelType) {
  if (modelType && typeof modelType.toDirectoryPath === "function") {
    return modelType;
  }
  const raw = typeString(modelType);
  const normalized = raw.toLowerCase()
    .replace(/::/g, "/").replace(/\s+/g, "/")
    .replace(/\./g, "/").replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  return { raw, normalized, toDirectoryPath: () => normalized };
}

export function redactArgs(globalArgs) {
  if (!globalArgs || typeof globalArgs !== "object") return globalArgs;
  const redacted = {};
  for (const [k, v] of Object.entries(globalArgs)) {
    if (/password|secret|token|key/i.test(k) && typeof v === "string") {
      redacted[k] = "***";
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

export function tableCell(val, maxLen = 120) {
  let s;
  if (val === null || val === undefined) {
    s = "-";
  } else if (typeof val === "object") {
    s = JSON.stringify(val);
  } else {
    s = String(val);
  }
  // collapse newlines and pipes so the table doesn't break
  s = s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  if (s.length > maxLen) s = s.slice(0, maxLen) + "\u2026";
  return s;
}

export function statusIcon(status) {
  switch (status) {
    case "compliant":
      return "\u2705";
    case "applied":
      return "\uD83D\uDD27";
    case "non_compliant":
      return "\u26A0\uFE0F";
    case "failed":
      return "\u274C";
    default:
      return "\u2753";
  }
}

export function dumpHandles(dataHandles) {
  if (!dataHandles) return "dataHandles is " + String(dataHandles);
  if (!Array.isArray(dataHandles)) {
    return "dataHandles is not an array: " + typeof dataHandles;
  }
  if (dataHandles.length === 0) return "dataHandles is empty []";
  return dataHandles.map((h, i) =>
    `[${i}] name=${JSON.stringify(h.name)} specName=${
      JSON.stringify(h.specName)
    } kind=${JSON.stringify(h.kind)} dataId=${
      JSON.stringify(h.dataId)
    } version=${h.version} keys=[${Object.keys(h).join(",")}]`
  ).join("\n");
}

export function dumpContext(context) {
  const lines = [];
  lines.push(`scope: ${JSON.stringify(context.scope)}`);
  lines.push(`modelType: ${JSON.stringify(context.modelType)}`);
  lines.push(`modelId: ${JSON.stringify(context.modelId)}`);
  lines.push(
    `definition: ${
      JSON.stringify(
        context.definition
          ? { id: context.definition.id, name: context.definition.name }
          : context.definition,
      )
    }`,
  );
  lines.push(`methodName: ${JSON.stringify(context.methodName)}`);
  lines.push(`executionStatus: ${JSON.stringify(context.executionStatus)}`);
  lines.push(
    `dataHandles:\n${dumpHandles(context.dataHandles)}`,
  );
  lines.push(
    `dataRepository: ${
      context.dataRepository ? typeof context.dataRepository : "missing"
    }`,
  );
  lines.push(`repoDir: ${JSON.stringify(context.repoDir)}`);
  return lines.join("\n");
}

export async function readFromHandle(
  dataRepository,
  modelType,
  modelId,
  handle,
) {
  try {
    const content = await dataRepository.getContent(
      asModelType(modelType),
      modelId,
      handle.name,
      handle.version,
    );
    if (content) return JSON.parse(decoder.decode(content));
  } catch { /* fall through */ }
  return null;
}

export function diagResult(
  modelName,
  modelType,
  method,
  execStatus,
  message,
  context,
) {
  const diag = dumpContext(context);
  return {
    markdown: [
      `## \u274C ${modelName}`,
      "",
      `**${message}**`,
      "",
      "### Report Context Dump",
      "",
      "```",
      diag,
      "```",
      "",
    ].join("\n"),
    json: {
      modelName,
      modelType,
      method,
      executionStatus: execStatus,
      status: "diagnostic",
      _diagnostic: message,
      _context: {
        scope: context.scope,
        modelType: context.modelType,
        modelId: context.modelId,
        methodName: context.methodName,
        executionStatus: context.executionStatus,
        dataHandleCount: context.dataHandles?.length ?? null,
        dataHandles: context.dataHandles?.map((h) => ({
          name: h.name,
          specName: h.specName,
          kind: h.kind,
          dataId: h.dataId,
          version: h.version,
        })) ?? null,
        hasDataRepository: !!context.dataRepository,
      },
    },
  };
}

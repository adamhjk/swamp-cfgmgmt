import {
  diagResult,
  readFromHandle,
  redactArgs,
  statusIcon,
  tableCell,
  typeString,
} from "./_lib/helpers.ts";

export const report = {
  name: "@adam/cfgmgmt-state",
  description: "Compliance state after check or apply",
  scope: "method",
  labels: ["cfgmgmt", "compliance"],
  execute: async (context) => {
    const modelName = context.definition.name;
    const modelType = typeString(context.modelType);
    const method = context.methodName;
    const execStatus = context.executionStatus;

    if (!context.dataHandles || !Array.isArray(context.dataHandles)) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        "dataHandles is missing or not an array",
        context,
      );
    }

    if (context.dataHandles.length === 0) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        "dataHandles is empty -- no data was returned by the method execution",
        context,
      );
    }

    const stateHandle = context.dataHandles.find(
      (h) => h.specName === "state",
    );
    if (!stateHandle) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        `No handle with specName="state" found in ${context.dataHandles.length} handle(s)`,
        context,
      );
    }

    const data = await readFromHandle(
      context.dataRepository,
      context.modelType,
      context.modelId,
      stateHandle,
    );
    if (!data) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        `Found state handle (name=${
          JSON.stringify(stateHandle.name)
        }, version=${stateHandle.version}) but dataRepository.getContent() returned null`,
        context,
      );
    }

    const status = data.status || "unknown";
    const icon = statusIcon(status);
    const changes = data.changes || [];
    const error = data.error || null;
    const timestamp = data.timestamp || "";
    const current = data.current || null;
    const gArgs = redactArgs(context.globalArgs);
    const mArgs = redactArgs(context.methodArgs);

    const lines = [
      `## ${icon} ${modelName}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| **Type** | \`${modelType}\` |`,
      `| **Method** | ${method} |`,
      `| **Status** | ${status} |`,
      `| **Timestamp** | ${timestamp} |`,
    ];

    if (error) {
      lines.push(`| **Error** | ${error} |`);
    }

    if (
      gArgs && typeof gArgs === "object" &&
      Object.keys(gArgs).length > 0
    ) {
      lines.push(
        "",
        "### Global Arguments",
        "",
        "| Argument | Value |",
        "| --- | --- |",
      );
      for (const [key, val] of Object.entries(gArgs)) {
        lines.push(`| ${key} | ${tableCell(val)} |`);
      }
    }

    if (
      mArgs && typeof mArgs === "object" &&
      Object.keys(mArgs).length > 0
    ) {
      lines.push(
        "",
        "### Method Arguments",
        "",
        "| Argument | Value |",
        "| --- | --- |",
      );
      for (const [key, val] of Object.entries(mArgs)) {
        lines.push(`| ${key} | ${tableCell(val)} |`);
      }
    }

    if (changes.length > 0) {
      lines.push("", "### Changes");
      for (const change of changes) {
        lines.push(`- ${change}`);
      }
    }

    if (current && typeof current === "object") {
      lines.push(
        "",
        "### Current State",
        "",
        "| Property | Value |",
        "| --- | --- |",
      );
      for (const [key, val] of Object.entries(current)) {
        lines.push(`| ${key} | ${tableCell(val)} |`);
      }
    }

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        modelName,
        modelType,
        method,
        executionStatus: execStatus,
        status,
        changes,
        error,
        timestamp,
        current,
        globalArgs: gArgs,
        methodArgs: mArgs,
      },
    };
  },
};

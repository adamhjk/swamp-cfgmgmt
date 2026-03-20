import {
  diagResult,
  readFromHandle,
  redactArgs,
  tableCell,
  typeString,
} from "./_lib/helpers.ts";

export const report = {
  name: "@adam/cfgmgmt-node-state",
  description: "Node info after gathering facts",
  scope: "method",
  labels: ["cfgmgmt"],
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

    const infoHandle = context.dataHandles.find(
      (h) => h.specName === "info",
    );
    if (!infoHandle) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        `No handle with specName="info" found in ${context.dataHandles.length} handle(s)`,
        context,
      );
    }

    const data = await readFromHandle(
      context.dataRepository,
      context.modelType,
      context.modelId,
      infoHandle,
    );
    if (!data) {
      return diagResult(
        modelName,
        modelType,
        method,
        execStatus,
        `Found info handle (name=${
          JSON.stringify(infoHandle.name)
        }, version=${infoHandle.version}) but dataRepository.getContent() returned null`,
        context,
      );
    }

    const icon = execStatus === "succeeded" ? "\u2705" : "\u274C";
    const pms = (data.packageManagers || []).join(", ");
    const gArgs = redactArgs(context.globalArgs);
    const mArgs = redactArgs(context.methodArgs);
    const lines = [
      `## ${icon} ${modelName}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| **Type** | \`${modelType}\` |`,
      `| **Method** | ${method} |`,
      `| **Hostname** | ${data.hostname} |`,
      `| **OS** | ${data.os} ${data.osVersion} |`,
      `| **Arch** | ${data.arch} |`,
      `| **Kernel** | ${data.kernel} |`,
      `| **Package Managers** | ${pms} |`,
      `| **Gathered At** | ${data.gatheredAt} |`,
    ];

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

    return {
      markdown: lines.join("\n") + "\n",
      json: {
        modelName,
        modelType,
        method,
        executionStatus: execStatus,
        hostname: data.hostname,
        os: data.os,
        osVersion: data.osVersion,
        arch: data.arch,
        kernel: data.kernel,
        packageManagers: data.packageManagers || [],
        gatheredAt: data.gatheredAt,
        globalArgs: gArgs,
        methodArgs: mArgs,
      },
    };
  },
};

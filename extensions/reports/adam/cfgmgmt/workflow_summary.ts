import { readFromHandle } from "./_lib/helpers.ts";

export const report = {
  name: "@adam/cfgmgmt-workflow-summary",
  description: "Aggregated compliance summary for a workflow run",
  scope: "workflow",
  labels: ["cfgmgmt", "compliance"],
  execute: async (context) => {
    const workflowName = context.workflowName;
    const workflowStatus = context.workflowStatus;
    const steps = context.stepExecutions;

    const succeeded = steps.filter((s) => s.status === "succeeded").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const skipped = steps.filter((s) => s.status === "skipped").length;
    const total = steps.length;

    const complianceCounts = {};
    const fleet = [];
    const errors = [];
    const stepDetails = [];

    for (const step of steps) {
      let complianceStatus = "unknown";
      let changes = [];
      let error = null;
      let dataRead = false;

      const handles = step.dataHandles || [];
      const stateHandle = handles.find((h) => h.specName === "state");
      const infoHandle = handles.find((h) => h.specName === "info");

      if (
        infoHandle && step.modelType.includes("node") &&
        step.methodName === "gather"
      ) {
        const result = await readFromHandle(
          context.dataRepository,
          step.modelType,
          step.modelId,
          infoHandle,
        );
        if (result) {
          fleet.push({
            hostname: result.hostname,
            os: result.os,
            osVersion: result.osVersion,
            arch: result.arch,
            kernel: result.kernel,
            packageManagers: result.packageManagers,
            gatheredAt: result.gatheredAt,
          });
          dataRead = true;
        }
        complianceStatus = "-";
      } else if (stateHandle) {
        const result = await readFromHandle(
          context.dataRepository,
          step.modelType,
          step.modelId,
          stateHandle,
        );
        if (result) {
          complianceStatus = result.status || "unknown";
          changes = result.changes || [];
          error = result.error || null;
          dataRead = true;
        }
      }

      if (step.status === "failed" && complianceStatus === "unknown") {
        complianceStatus = "failed";
        error = error || step.error || "step failed (no error details)";
      }

      if (step.status === "skipped") {
        complianceStatus = "-";
      }

      if (complianceStatus !== "-" && complianceStatus !== "unknown") {
        complianceCounts[complianceStatus] =
          (complianceCounts[complianceStatus] || 0) + 1;
      }

      if (error) {
        errors.push({
          stepName: step.stepName,
          modelName: step.modelName,
          error,
        });
      }

      stepDetails.push({
        jobName: step.jobName,
        stepName: step.stepName,
        modelName: step.modelName,
        modelType: step.modelType,
        methodName: step.methodName,
        executionStatus: step.status,
        complianceStatus,
        changes,
        error,
        dataRead,
      });
    }

    // Build markdown
    const md = [
      `# Workflow Summary: ${workflowName}`,
      "",
      `**Status**: ${workflowStatus}`,
      `**Steps**: ${total} total | ${succeeded} succeeded | ${failed} failed | ${skipped} skipped`,
    ];

    if (errors.length > 0) {
      md.push("", "## Errors", "");
      for (const e of errors) {
        md.push(`- **${e.stepName}** (${e.modelName}): ${e.error}`);
      }
    }

    if (fleet.length > 0) {
      md.push(
        "",
        "## Fleet",
        "",
        "| Hostname | OS | Version | Arch | Kernel | Package Managers |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const node of fleet) {
        const pms = (node.packageManagers || []).join(", ");
        md.push(
          `| ${node.hostname} | ${node.os} | ${node.osVersion} | ${node.arch} | ${node.kernel} | ${pms} |`,
        );
      }
    }

    if (Object.keys(complianceCounts).length > 0) {
      md.push(
        "",
        "## Compliance Overview",
        "",
        "| Status | Count |",
        "| --- | --- |",
      );
      const sorted = Object.entries(complianceCounts).sort((a, b) =>
        b[1] - a[1]
      );
      for (const [status, count] of sorted) {
        md.push(`| ${status} | ${count} |`);
      }
    }

    const jobNames = [...new Set(stepDetails.map((s) => s.jobName))];
    for (const jobName of jobNames) {
      const jobSteps = stepDetails.filter((s) => s.jobName === jobName);
      md.push(
        "",
        `## ${jobName}`,
        "",
        "| Step | Model | Method | Status | Compliance | Changes |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const s of jobSteps) {
        const shortType = s.modelType.split("/").pop() || s.modelType;
        const changesDisplay = s.complianceStatus === "-"
          ? "-"
          : s.dataRead
          ? String(s.changes.length)
          : "-";
        md.push(
          `| ${s.stepName} | ${shortType} | ${s.methodName} | ${s.executionStatus} | ${s.complianceStatus} | ${changesDisplay} |`,
        );
      }
    }

    return {
      markdown: md.join("\n") + "\n",
      json: {
        workflowName,
        workflowStatus,
        summary: {
          total,
          succeeded,
          failed,
          skipped,
          compliance: complianceCounts,
        },
        fleet,
        jobs: Object.fromEntries(
          jobNames.map((name) => [
            name,
            stepDetails.filter((s) => s.jobName === name),
          ]),
        ),
        steps: stepDetails,
      },
    };
  },
};

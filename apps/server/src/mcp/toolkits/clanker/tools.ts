import {
  ClankerRunDetail,
  ClankerRunId,
  ClankerRunListResult,
  ClankerRunResumeResult,
  ClankerRunStartResult,
  ClankerWorkflowDocument,
  ClankerWorkflowListResult,
  ClankerWorkflowPath,
  ClankerWorkflowValidateResult,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ClankerRunService from "../../../clanker/ClankerRunService.ts";
import * as ClankerWorkflowService from "../../../clanker/ClankerWorkflowService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ClankerWorkflowService.ClankerWorkflowService,
  ClankerRunService.ClankerRunService,
];

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};

/**
 * Omitted `projectId` falls back to the calling thread's project, matching the
 * other project-scoped tools.
 */
const projectIdParam = {
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Project owning the workflow files. Omit inside a T3 thread to use its project.",
    }),
  ),
};

const ClankerListWorkflowsTool = Tool.make("clanker_list_workflows", {
  ...shared,
  description:
    "List the Clanker workflow files stored under .clanker/workflows/ in a project: name, version, description, step count, last-modified time, and a count of errors and unsupported constructs. Omit projectId to use the calling thread's project.",
  parameters: Schema.Struct(projectIdParam),
  success: ClankerWorkflowListResult,
  dependencies,
})
  .annotate(Tool.Title, "List clanker workflows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ClankerGetWorkflowTool = Tool.make("clanker_get_workflow", {
  ...shared,
  description:
    "Read one Clanker workflow file by its project-relative path (as returned by clanker_list_workflows, e.g. .clanker/workflows/deploy.yaml). Returns the file content, parse diagnostics, and the computed dependency waves.",
  parameters: Schema.Struct({
    ...projectIdParam,
    path: ClankerWorkflowPath.annotate({
      description: "Project-relative workflow path under .clanker/workflows/.",
    }),
  }),
  success: ClankerWorkflowDocument,
  dependencies,
})
  .annotate(Tool.Title, "Read clanker workflow")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ClankerValidateWorkflowTool = Tool.make("clanker_validate_workflow", {
  ...shared,
  description:
    "Validate Clanker workflow YAML/JSON content without touching the filesystem: schema errors, unsupported constructs the T3 Code runner ignores (conditions, run steps, sub-workflows, fn hooks, agent files, escalation handlers, jinja2 templates), and dependency problems such as cycles or missing depends_on targets.",
  parameters: Schema.Struct({
    content: TrimmedNonEmptyString.annotate({
      description: "The workflow file content to validate.",
    }),
  }),
  success: ClankerWorkflowValidateResult,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Validate clanker workflow")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ClankerStartRunTool = Tool.make("clanker_start_run", {
  ...shared,
  description:
    "Start a run of a Clanker workflow: each step gets one T3 thread (parallel wave steps run in parallel threads), prompt x model pairs become turns, cmd hooks and QA checks run as shell commands in the project root. Step threads run with this caller's runtime/interaction modes, capped to what the caller may use. Returns the run id immediately; watch progress with clanker_list_runs or clanker_get_run.",
  parameters: Schema.Struct({
    ...projectIdParam,
    workflowPath: ClankerWorkflowPath.annotate({
      description: "Project-relative workflow path under .clanker/workflows/.",
    }),
    providerInstanceId: Schema.optional(
      ProviderInstanceId.annotate({
        description:
          "Provider instance to run the step threads on. Defaults to the project's default model's instance.",
      }),
    ),
    model: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Provider model override for the run's step threads.",
      }),
    ),
    startFromStep: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Clanker resume gate: steps before it with no restored state still run.",
      }),
    ),
  }),
  success: ClankerRunStartResult,
  dependencies,
})
  .annotate(Tool.Title, "Start clanker run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ClankerListRunsTool = Tool.make("clanker_list_runs", {
  ...shared,
  description:
    "List Clanker workflow runs recorded under .clanker/runs/ in a project: status, per-step counts, and start/update times. Omit projectId to use the calling thread's project.",
  parameters: Schema.Struct(projectIdParam),
  success: ClankerRunListResult,
  dependencies,
})
  .annotate(Tool.Title, "List clanker runs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ClankerGetRunTool = Tool.make("clanker_get_run", {
  ...shared,
  description:
    "Read one Clanker run: status, per-step state (status, retries, responses, outputs, error), and the T3 thread each step ran in.",
  parameters: Schema.Struct({
    ...projectIdParam,
    runId: ClankerRunId.annotate({
      description: "Run id as returned by clanker_start_run or clanker_list_runs.",
    }),
  }),
  success: ClankerRunDetail,
  dependencies,
})
  .annotate(Tool.Title, "Get clanker run")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ClankerResumeRunTool = Tool.make("clanker_resume_run", {
  ...shared,
  description:
    "Resume a stopped or failed Clanker run: steps that already passed or were skipped are restored from the run's state.json, and the remaining steps run again in the step threads recorded in the run's t3-threads.json (or new threads when none are recorded). The step threads inherit this caller's runtime/interaction modes.",
  parameters: Schema.Struct({
    ...projectIdParam,
    runId: ClankerRunId.annotate({
      description: "Run id to resume, as returned by clanker_start_run or clanker_list_runs.",
    }),
    startFromStep: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Clanker resume gate: steps before it with no restored state still run. Defaults to the first step that did not pass or was skipped.",
      }),
    ),
  }),
  success: ClankerRunResumeResult,
  dependencies,
})
  .annotate(Tool.Title, "Resume clanker run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ClankerCancelRunTool = Tool.make("clanker_cancel_run", {
  ...shared,
  description:
    "Cancel a running Clanker run: in-flight provider turns are interrupted, pending steps stop, and the run's state.json is marked cancelled.",
  parameters: Schema.Struct({
    ...projectIdParam,
    runId: ClankerRunId.annotate({
      description: "Run id to cancel.",
    }),
  }),
  dependencies,
})
  .annotate(Tool.Title, "Cancel clanker run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ClankerToolkit = Toolkit.make(
  ClankerListWorkflowsTool,
  ClankerGetWorkflowTool,
  ClankerValidateWorkflowTool,
  ClankerStartRunTool,
  ClankerListRunsTool,
  ClankerGetRunTool,
  ClankerResumeRunTool,
  ClankerCancelRunTool,
);

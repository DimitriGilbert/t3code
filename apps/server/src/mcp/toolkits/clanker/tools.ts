import {
  ClankerWorkflowDocument,
  ClankerWorkflowListResult,
  ClankerWorkflowPath,
  ClankerWorkflowValidateResult,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ClankerWorkflowService from "../../../clanker/ClankerWorkflowService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ClankerWorkflowService.ClankerWorkflowService,
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

export const ClankerToolkit = Toolkit.make(
  ClankerListWorkflowsTool,
  ClankerGetWorkflowTool,
  ClankerValidateWorkflowTool,
);

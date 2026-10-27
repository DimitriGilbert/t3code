import { buildClankerWaves } from "@t3tools/clanker/dag";
import { parseClankerWorkflow } from "@t3tools/clanker/parse";
import { OrchestratorMcpFailure, type ClankerWorkflowError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ClankerWorkflowService from "../../../clanker/ClankerWorkflowService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ClankerToolkit } from "./tools.ts";

const workflowFailure = (error: ClankerWorkflowError) =>
  error._tag === "ClankerWorkflowReadError" || error._tag === "ClankerWorkflowWriteError"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const handlers = {
  clanker_list_workflows: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const workflows = yield* ClankerWorkflowService.ClankerWorkflowService;
      const listed = yield* workflows.list({ projectId }).pipe(Effect.mapError(workflowFailure));
      return { workflows: [...listed] };
    }),
  ),
  clanker_get_workflow: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const workflows = yield* ClankerWorkflowService.ClankerWorkflowService;
      return yield* workflows
        .get({ projectId, path: input.path })
        .pipe(Effect.mapError(workflowFailure));
    }),
  ),
  clanker_validate_workflow: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const result = parseClankerWorkflow(input.content);
      const diagnostics =
        result.workflow === undefined
          ? result.diagnostics
          : [...result.diagnostics, ...buildClankerWaves(result.workflow.steps).diagnostics];
      return { diagnostics };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ClankerToolkit.tools>;

export const layer = McpToolAccess.toLayer(ClankerToolkit, handlers);

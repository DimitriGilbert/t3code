import { buildClankerWaves } from "@t3tools/clanker/dag";
import { parseClankerWorkflow } from "@t3tools/clanker/parse";
import {
  OrchestratorMcpFailure,
  type ClankerRunError,
  type ClankerWorkflowError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ClankerRunService from "../../../clanker/ClankerRunService.ts";
import * as ClankerWorkflowService from "../../../clanker/ClankerWorkflowService.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ClankerToolkit } from "./tools.ts";

const workflowFailure = (error: ClankerWorkflowError) =>
  error._tag === "ClankerWorkflowReadError" || error._tag === "ClankerWorkflowWriteError"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const runFailure = (error: ClankerRunError | ClankerWorkflowError) =>
  error._tag === "ClankerRunNotFoundError"
    ? new OrchestratorMcpFailure({ code: "run_not_found", message: error.message })
    : error._tag === "ClankerRunIoError" ||
        error._tag === "ClankerWorkflowReadError" ||
        error._tag === "ClankerWorkflowWriteError"
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
  clanker_start_run: McpToolAccess.startsThreads(
    () => ({}),
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const projectId = yield* resolveProjectId(context, input.projectId);
        const runs = yield* ClankerRunService.ClankerRunService;
        return yield* runs
          .start({
            projectId,
            workflowPath: input.workflowPath,
            ...(input.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: input.providerInstanceId }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.startFromStep === undefined ? {} : { startFromStep: input.startFromStep }),
            runtimeMode,
            interactionMode,
          })
          .pipe(
            Effect.mapError(runFailure),
            // The run's fibers inherit this context, so dispatches to a
            // step thread whose modes exceed the caller's are refused by
            // the orchestrator's under-lock re-check, as for writesThreads.
            Effect.provideService(DispatchModeLimit, { runtimeMode, interactionMode }),
          );
      }),
  ),
  clanker_list_runs: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const runs = yield* ClankerRunService.ClankerRunService;
      const listed = yield* runs.list({ projectId }).pipe(Effect.mapError(runFailure));
      return { runs: [...listed] };
    }),
  ),
  clanker_get_run: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const runs = yield* ClankerRunService.ClankerRunService;
      return yield* runs.get({ projectId, runId: input.runId }).pipe(Effect.mapError(runFailure));
    }),
  ),
  clanker_resume_run: McpToolAccess.startsThreads(
    () => ({}),
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const projectId = yield* resolveProjectId(context, input.projectId);
        const runs = yield* ClankerRunService.ClankerRunService;
        return yield* runs
          .resume({
            projectId,
            runId: input.runId,
            ...(input.startFromStep === undefined ? {} : { startFromStep: input.startFromStep }),
            runtimeMode,
            interactionMode,
          })
          .pipe(
            Effect.mapError(runFailure),
            // Same dispatch re-check as start: resuming continues whatever
            // step threads the run recorded, whose modes may exceed this
            // caller's; the orchestrator refuses those sends instead of
            // letting the caller drive an above-limit thread.
            Effect.provideService(DispatchModeLimit, { runtimeMode, interactionMode }),
          );
      }),
  ),
  clanker_cancel_run: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const runs = yield* ClankerRunService.ClankerRunService;
      yield* runs.cancel({ projectId, runId: input.runId }).pipe(Effect.mapError(runFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ClankerToolkit.tools>;

export const layer = McpToolAccess.toLayer(ClankerToolkit, handlers);

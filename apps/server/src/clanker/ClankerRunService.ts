/**
 * Drives Clanker workflow runs on the pure `@t3tools/clanker/runner` engine:
 * one thread per step via `ThreadLaunchService`, follow-up turns queued
 * through `ThreadManagementService`, cmd hooks via `ProcessRunner`, and
 * `.clanker/runs/<runId>/state.json` persisted atomically per transition.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { decodeJsonResult, fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { buildClankerWaves } from "@t3tools/clanker/dag";
import type { ClankerWorkflow } from "@t3tools/clanker/format";
import { parseClankerWorkflow } from "@t3tools/clanker/parse";
import {
  cancelClankerRun,
  clankerCmdHookSettled,
  clankerPromptSettled,
  clankerQaCheckSettled,
  clankerRunToPersistedState,
  clankerStepFailed,
  startClankerRun,
  type ClankerEngineAction,
  type ClankerEngineState,
  type ClankerEngineTransition,
  type ClankerRestoredStep,
} from "@t3tools/clanker/runner";
import { ClankerPersistedRunState, ClankerRunResult } from "@t3tools/clanker/runState";
import {
  ClankerRunAlreadyRunningError,
  ClankerRunId,
  ClankerRunInvalidStateError,
  ClankerRunIoError,
  ClankerRunNotFoundError,
  ClankerWorkflowPath,
  ClankerWorkflowReadError,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type ClankerRunCancelInput,
  type ClankerRunDetail,
  type ClankerRunError,
  type ClankerRunGetInput,
  type ClankerRunListInput,
  type ClankerRunResumeInput,
  type ClankerRunStartInput,
  type ClankerRunStartResult,
  type ClankerRunSummary,
  type ClankerStepThread,
  type ClankerWorkflowError,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
} from "@t3tools/contracts";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ClankerWorkflowService from "./ClankerWorkflowService.ts";

const RUNS_DIR_RELATIVE = ".clanker/runs";
const PROMPTS_DIR_RELATIVE = ".clanker/prompts";
const THREADS_SIDECAR_NAME = "t3-threads.json";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROMPT_FILE_UNSAFE_CHARS = /[^a-zA-Z0-9_-]+/g;
/**
 * `waitForThread` requires a bound; the per-step timeout race owns real
 * timing, so this only keeps a lost turn from waiting forever.
 */
const TURN_SETTLE_WAIT_MS = Duration.toMillis(Duration.days(7));

// --- Executor --------------------------------------------------------------
// The service-facing boundary for everything a run touches outside its own
// files: provider turns (thread launch, queued sends, settle waits, turn
// interrupt) and shell commands. Tests substitute this service; the engine
// driving loop, persistence, and step locks stay real.

export interface ClankerPromptTurnInput {
  readonly runId: ClankerRunId;
  readonly projectId: ProjectId;
  readonly stepName: string;
  readonly attempt: number;
  readonly promptIndex: number;
  readonly modelIndex: number;
  readonly renderedPrompt: string;
  readonly threadId: ThreadId | undefined;
  readonly threadTitle: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** `responseText` is set on success, `error` on failure — never both. */
export interface ClankerPromptTurnOutcome {
  readonly threadId: ThreadId | undefined;
  readonly responseText?: string | undefined;
  readonly error?: string | undefined;
}

export interface ClankerRunCommandInput {
  readonly runId: ClankerRunId;
  readonly stepName: string;
  readonly cmd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface ClankerRunCommandOutcome {
  readonly exitCode: number | null;
  readonly error?: string | undefined;
}

export class ClankerRunExecutor extends Context.Service<
  ClankerRunExecutor,
  {
    /**
     * Runs one provider turn for a step: launches the step thread when
     * `threadId` is absent, else queues a follow-up, then waits for a
     * terminal run status and reads back the final assistant text.
     */
    readonly runPromptTurn: (
      input: ClankerPromptTurnInput,
    ) => Effect.Effect<ClankerPromptTurnOutcome>;
    /** Runs a clanker hook/QA cmd in a platform shell at `cwd`. */
    readonly runCommand: (input: ClankerRunCommandInput) => Effect.Effect<ClankerRunCommandOutcome>;
  }
>()("t3/clanker/ClankerRunService/ClankerRunExecutor") {}

const outcomeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const layerExecutor = Layer.effect(
  ClankerRunExecutor,
  Effect.gen(function* () {
    const launches = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const processes = yield* ProcessRunner.ProcessRunner;

    const runPromptTurn: ClankerRunExecutor["Service"]["runPromptTurn"] = Effect.fn(
      "ClankerRunExecutor.runPromptTurn",
    )(function* (input) {
      const commandKey = `clanker:${input.runId}:${input.stepName}:${input.attempt}:${input.promptIndex}:${input.modelIndex}`;
      const messageId = MessageId.make(`${commandKey}:message`);
      // Turn ids are recorded only after dispatch commits, so an interrupt
      // always reaches the turn it abandons.
      const inFlight = yield* Ref.make<
        Option.Option<{ readonly threadId: ThreadId; readonly runId: RunId }>
      >(Option.none());
      const interruptInFlight = Ref.get(inFlight).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (turn) =>
              threads
                .interruptThread({
                  projectId: input.projectId,
                  commandId: CommandId.make(`${commandKey}:interrupt`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  reason: "The clanker run was cancelled or timed out.",
                })
                .pipe(Effect.ignoreCause({ log: true })),
          }),
        ),
      );

      const work = Effect.gen(function* () {
        const threadId = input.threadId;
        // Uninterruptible through the `inFlight` write, so an interrupt can
        // never strand a turn whose ids were never recorded: a landing
        // interrupt still reaches the turn it abandons via interruptInFlight.
        const started = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const dispatched = yield* threadId === undefined
              ? launches
                  .launch({
                    commandId: CommandId.make(`${commandKey}:launch`),
                    projectId: input.projectId,
                    title: input.threadTitle,
                    modelSelection: input.modelSelection,
                    runtimeMode: input.runtimeMode,
                    interactionMode: input.interactionMode,
                    workspaceStrategy: { type: "root" },
                    initialMessage: {
                      messageId,
                      text: input.renderedPrompt,
                      attachments: [],
                    },
                    createdBy: "agent",
                    creationSource: "server",
                  })
                  .pipe(
                    Effect.map((launched) => ({
                      threadId: launched.threadId,
                      runId:
                        launched.projection.messages.find((message) => message.id === messageId)
                          ?.runId ?? ThreadManagementService.latestRun(launched.projection)?.id,
                    })),
                  )
              : threads
                  .sendToThread({
                    projectId: input.projectId,
                    commandId: CommandId.make(`${commandKey}:send`),
                    threadId,
                    messageId,
                    text: input.renderedPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "server",
                  })
                  .pipe(Effect.map((sent) => ({ threadId, runId: sent.run.id })));
            if (dispatched.runId !== null && dispatched.runId !== undefined) {
              yield* Ref.set(
                inFlight,
                Option.some({ threadId: dispatched.threadId, runId: dispatched.runId }),
              );
            }
            return dispatched;
          }),
        );
        if (started.runId === null || started.runId === undefined) {
          return {
            threadId: started.threadId,
            error: "The turn's message produced no durable run.",
          } satisfies ClankerPromptTurnOutcome;
        }
        const waited = yield* threads.waitForThread({
          projectId: input.projectId,
          threadId: started.threadId,
          runId: started.runId,
          timeoutMs: TURN_SETTLE_WAIT_MS,
        });
        if (waited.timedOut) {
          return {
            threadId: started.threadId,
            error: `The turn did not settle within ${Duration.format(Duration.millis(TURN_SETTLE_WAIT_MS))}.`,
          } satisfies ClankerPromptTurnOutcome;
        }
        const records = yield* threads.getThreadRecords(started.threadId, ["turnItems"], {
          turnItemRunIds: [started.runId],
          turnItemTypes: ["assistant_message", "error"],
        });
        const ordered = records.turnItems.toSorted((left, right) => left.ordinal - right.ordinal);
        const assistantText = ordered.findLast((item) => item.type === "assistant_message")?.text;
        const failureItem = ordered.findLast(
          (item): item is Extract<(typeof ordered)[number], { readonly type: "error" }> =>
            item.type === "error",
        );
        const run = waited.run;
        if (run === null) {
          return {
            threadId: started.threadId,
            error: `Run ${started.runId} was never recorded.`,
          } satisfies ClankerPromptTurnOutcome;
        }
        if (run.status === "completed") {
          return {
            threadId: started.threadId,
            responseText: assistantText ?? "",
          } satisfies ClankerPromptTurnOutcome;
        }
        return {
          threadId: started.threadId,
          error: failureItem?.failure.message ?? `The turn ended with status "${run.status}".`,
        } satisfies ClankerPromptTurnOutcome;
      });

      return yield* work.pipe(
        Effect.catch((error) =>
          Ref.get(inFlight).pipe(
            Effect.map((turn) => ({
              threadId: Option.isSome(turn) ? turn.value.threadId : input.threadId,
              error: outcomeErrorMessage(error),
            })),
          ),
        ),
        Effect.onInterrupt(() => interruptInFlight),
      );
    });

    const runCommand: ClankerRunExecutor["Service"]["runCommand"] = Effect.fn(
      "ClankerRunExecutor.runCommand",
    )(function* (input) {
      const platform = yield* HostProcess.Platform;
      const hostEnv = yield* HostProcess.Environment;
      const shell =
        platform === "win32"
          ? {
              command: hostEnv.ComSpec ?? hostEnv.COMSPEC ?? "cmd.exe",
              args: ["/d", "/s", "/c", input.cmd],
            }
          : { command: "/bin/sh", args: ["-c", input.cmd] };
      // The service's step-timeout race owns timing; Duration.infinity keeps
      // ProcessRunner's 60s default from cutting long hooks short.
      // Interrupting this effect kills the child through the scoped spawn.
      return yield* processes
        .run({
          command: shell.command,
          args: shell.args,
          cwd: input.cwd,
          env: input.env,
          timeout: Duration.infinity,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          truncatedMarker: "\n[output truncated]",
        })
        .pipe(
          Effect.match({
            onFailure: (error) =>
              ({ exitCode: null, error: error.message }) satisfies ClankerRunCommandOutcome,
            onSuccess: (output): ClankerRunCommandOutcome => {
              if (output.timedOut) {
                return { exitCode: null, error: "Command timed out." };
              }
              const detail = output.stderr.trim() || output.stdout.trim();
              return {
                exitCode: output.code,
                ...(output.code === 0 || detail.length === 0 ? {} : { error: detail }),
              };
            },
          }),
        );
    });

    return ClankerRunExecutor.of({ runPromptTurn, runCommand });
  }),
);

// --- Run service -----------------------------------------------------------

interface RunRecord {
  readonly runId: ClankerRunId;
  readonly projectId: ProjectId;
  readonly workflowName: string;
  readonly workflowPath: ClankerWorkflowPath | undefined;
  /** Absolute directory the workflow file lives in (prompt files + outputs resolve here). */
  readonly workflowDirAbs: string;
  /** Absolute `.clanker/runs/<runId>` directory. */
  readonly runDirAbs: string;
  readonly workspaceRoot: string;
  readonly startedAt: string;
  /** Last transition time, mirrored into `state.json` `updatedAt`. */
  updatedAt: string;
  readonly modelSelection: ModelSelection;
  /** Modes the run's step threads launch under, resolved once at start/resume. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * Latest engine state. Only mutated inside `transitions`, so reads outside
   * it (action payloads, detail queries) always see a consistent snapshot.
   */
  state: ClankerEngineState;
  /** Step name -> thread the step's turns run in (persisted to t3-threads.json). */
  readonly stepThreads: Map<string, ThreadId>;
  /** Serializes engine transitions; every settle and cancel goes through it. */
  readonly transitions: Semaphore.Semaphore;
  /**
   * Per-step locks serialize same-step prompt pairs: a pair must observe the
   * thread an earlier pair launched before deciding to launch its own.
   * Same-step pairs run sequentially in that thread regardless.
   */
  readonly stepLocks: Map<string, Semaphore.Semaphore>;
  /** Closing it interrupts every in-flight action of the run. */
  readonly scope: Scope.Closeable;
}

/** Project-relative workflow paths are POSIX; dirname is string surgery. */
const dirnamePosix = (relativePath: string) => {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "." : relativePath.slice(0, index);
};

const decodePersistedState = decodeJsonResult(ClankerPersistedRunState);
const encodePersistedState = Schema.encodeSync(fromJsonStringPretty(ClankerPersistedRunState));
const decodeStepThreadsFile = decodeJsonResult(
  Schema.Struct({ steps: Schema.Record(Schema.String, ThreadId) }),
);
const encodeStepThreadsFile = Schema.encodeSync(
  fromJsonStringPretty(Schema.Struct({ steps: Schema.Record(Schema.String, ThreadId) })),
);
const encodeRunResult = Schema.encodeSync(fromJsonStringPretty(ClankerRunResult));

export class ClankerRunService extends Context.Service<
  ClankerRunService,
  {
    readonly list: (
      input: ClankerRunListInput,
    ) => Effect.Effect<ReadonlyArray<ClankerRunSummary>, ClankerRunError>;
    readonly get: (input: ClankerRunGetInput) => Effect.Effect<ClankerRunDetail, ClankerRunError>;
    readonly subscribe: (
      input: ClankerRunListInput,
    ) => Stream.Stream<ReadonlyArray<ClankerRunSummary>, ClankerRunError>;
    readonly start: (
      input: ClankerRunStartInput,
    ) => Effect.Effect<ClankerRunStartResult, ClankerRunError | ClankerWorkflowError>;
    readonly cancel: (input: ClankerRunCancelInput) => Effect.Effect<void, ClankerRunError>;
    readonly resume: (
      input: ClankerRunResumeInput,
    ) => Effect.Effect<{ runId: ClankerRunId }, ClankerRunError | ClankerWorkflowError>;
  }
>()("t3/clanker/ClankerRunService") {}

export const layer = Layer.effect(
  ClankerRunService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workflows = yield* ClankerWorkflowService.ClankerWorkflowService;
    const executor = yield* ClankerRunExecutor;
    const crypto = yield* Crypto.Crypto;
    const serviceScope = yield* Effect.scope;
    // Sliding(1) coalesces the dirty-signal: a notification re-lists anyway.
    const changesPubSub = yield* PubSub.sliding<ProjectId>(1);
    const notifyChanged = (projectId: ProjectId) =>
      PubSub.publish(changesPubSub, projectId).pipe(Effect.asVoid);
    const runs = new Map<string, RunRecord>();
    /** Guards the `runs` map (add/remove). */
    const runsMutex = yield* Semaphore.make(1);

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...runs.values()], (record) => Scope.close(record.scope, Exit.void), {
        discard: true,
      }),
    );

    const isMissingEntry = (cause: { readonly reason: { readonly _tag: string } }) =>
      cause.reason._tag === "NotFound";

    const ioError = (pathValue: string, cause: unknown) =>
      new ClankerRunIoError({ path: pathValue, cause });

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    /** `null` means the project is gone — reads then behave as an empty store. */
    const workspaceShellFor = Effect.fn("ClankerRunService.workspaceShellFor")(function* (
      projectId: ProjectId,
    ) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(Effect.mapError((cause) => ioError(projectId, cause)));
      return Option.isSome(shell) ? shell.value : null;
    });

    const runDirFor = Effect.fn("ClankerRunService.runDirFor")(function* (
      workspaceRoot: string,
      runId: string,
    ) {
      if (!RUN_ID_PATTERN.test(runId)) {
        return yield* new ClankerRunNotFoundError({ runId });
      }
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot,
          relativePath: `${RUNS_DIR_RELATIVE}/${runId}`,
        })
        .pipe(Effect.mapError(() => new ClankerRunNotFoundError({ runId })));
      return resolved.absolutePath;
    });

    const writeFileAtomic = Effect.fn("ClankerRunService.writeFileAtomic")(function* (
      absolutePath: string,
      content: string,
    ) {
      yield* fileSystem
        .makeDirectory(path.dirname(absolutePath), { recursive: true })
        .pipe(Effect.mapError((cause) => ioError(absolutePath, cause)));
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const temporary = `${absolutePath}.${uuid}.tmp`;
      yield* fileSystem
        .writeFileString(temporary, content)
        .pipe(Effect.mapError((cause) => ioError(absolutePath, cause)));
      yield* fileSystem
        .rename(temporary, absolutePath)
        .pipe(Effect.mapError((cause) => ioError(absolutePath, cause)));
    });

    /** Reads a run's `state.json`; missing or undecodable files return undefined. */
    const readPersistedState = Effect.fn("ClankerRunService.readPersistedState")(function* (
      runDirAbs: string,
    ) {
      const content = yield* fileSystem
        .readFileString(path.join(runDirAbs, "state.json"))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (content === undefined) return undefined;
      const decoded = decodePersistedState(content);
      return Result.isSuccess(decoded) ? decoded.success : undefined;
    });

    const readStepThreads = Effect.fn("ClankerRunService.readStepThreads")(function* (
      runDirAbs: string,
    ) {
      const content = yield* fileSystem
        .readFileString(path.join(runDirAbs, THREADS_SIDECAR_NAME))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (content === undefined) return new Map<string, ThreadId>();
      const decoded = decodeStepThreadsFile(content);
      return Result.isSuccess(decoded)
        ? new Map<string, ThreadId>(Object.entries(decoded.success.steps))
        : new Map<string, ThreadId>();
    });

    const writeStepThreads = Effect.fn("ClankerRunService.writeStepThreads")(function* (
      record: RunRecord,
    ) {
      yield* writeFileAtomic(
        path.join(record.runDirAbs, THREADS_SIDECAR_NAME),
        encodeStepThreadsFile({ steps: Object.fromEntries(record.stepThreads) }),
      );
    });

    const persistState = Effect.fn("ClankerRunService.persistState")(function* (record: RunRecord) {
      const persisted = clankerRunToPersistedState(record.state, {
        runId: record.runId,
        ...(record.workflowPath === undefined ? {} : { workflowPath: record.workflowPath }),
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
      });
      yield* writeFileAtomic(
        path.join(record.runDirAbs, "state.json"),
        encodePersistedState(persisted),
      );
    });

    /** `null` skips a persisted state whose fields cannot brand — never breaks the list. */
    const toSummary = (persisted: ClankerPersistedRunState): ClankerRunSummary | null => {
      if (!RUN_ID_PATTERN.test(persisted.runId)) return null;
      const steps = Object.values(persisted.steps);
      return {
        runId: ClankerRunId.make(persisted.runId),
        workflowName: persisted.workflowName.trim() || persisted.runId,
        ...(persisted.workflowPath === undefined || persisted.workflowPath.trim().length === 0
          ? {}
          : { workflowPath: ClankerWorkflowPath.make(persisted.workflowPath) }),
        status: persisted.status,
        startedAt: persisted.startedAt,
        updatedAt: persisted.updatedAt,
        stepTotal: steps.length,
        passedSteps: steps.filter((step) => step.status === "passed" || step.status === "skipped")
          .length,
        failedSteps: steps.filter((step) => step.status === "failed").length,
        runningSteps: steps.filter((step) => step.status === "running").length,
      };
    };

    const listForRoot = Effect.fn("ClankerRunService.listForRoot")(function* (
      workspaceRoot: string,
    ) {
      const runsDir = path.join(workspaceRoot, ".clanker", "runs");
      const entries = yield* fileSystem.readDirectory(runsDir).pipe(
        Effect.catchIf(isMissingEntry, () => Effect.succeed([] as ReadonlyArray<string>)),
        Effect.mapError((cause) => ioError(RUNS_DIR_RELATIVE, cause)),
      );
      const summaries = yield* Effect.forEach(
        entries.filter((entry) => RUN_ID_PATTERN.test(entry)),
        (entry) =>
          readPersistedState(path.join(runsDir, entry)).pipe(
            Effect.map((persisted) => (persisted === undefined ? null : toSummary(persisted))),
          ),
        { concurrency: 8 },
      );
      return summaries
        .filter((summary): summary is ClankerRunSummary => summary !== null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });

    // --- Engine driving -----------------------------------------------------

    const stepLockFor = (record: RunRecord, stepName: string) =>
      // runsMutex is never held across other awaits, so it can guard the
      // lock map without risking lock cycles.
      runsMutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = record.stepLocks.get(stepName);
          if (existing !== undefined) return existing;
          const created = yield* Semaphore.make(1);
          record.stepLocks.set(stepName, created);
          return created;
        }),
      );

    /**
     * Verify declared outputs the way Clanker does: existence of the declared
     * path (resolved against the workflow directory) is the whole check, and
     * the recorded value is the path as written.
     */
    const verifyOutputs = Effect.fn("ClankerRunService.verifyOutputs")(function* (
      record: RunRecord,
      declaredOutputs: Readonly<Record<string, string>>,
    ) {
      const verified: Record<string, string> = {};
      for (const [key, declared] of Object.entries(declaredOutputs)) {
        const absolute = path.isAbsolute(declared)
          ? declared
          : path.resolve(record.workflowDirAbs, declared);
        const exists = yield* fileSystem.exists(absolute).pipe(Effect.orElseSucceed(() => false));
        if (exists) verified[key] = declared;
      }
      return verified;
    });

    const verifiedOutputs = (
      record: RunRecord,
      declaredOutputs: Readonly<Record<string, string>>,
    ) =>
      verifyOutputs(record, declaredOutputs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Unable to verify clanker step outputs", {
            runId: record.runId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({})),
        ),
      );

    /**
     * Race an action against its step timeout. `Effect.race` interrupts the
     * loser, which cancels the in-flight provider turn (executor onInterrupt)
     * or kills the child process (scoped spawn); the step then fails hard via
     * `clankerStepFailed`, matching Clanker's thrown-error path.
     */
    const withStepTimeout = <A, E, R>(
      record: RunRecord,
      stepName: string,
      effect: Effect.Effect<A, E, R>,
    ) => {
      const timeout = record.state.stepsByName.get(stepName)?.timeout;
      return timeout === undefined
        ? Effect.map(effect, (value) => ({ type: "settled", value }) as const)
        : Effect.race(
            Effect.map(effect, (value) => ({ type: "settled", value }) as const),
            Effect.as(Effect.sleep(Duration.seconds(timeout)), { type: "timedOut" } as const),
          );
    };

    const stepTimedOut = (record: RunRecord, stepName: string, attempt: number) =>
      settle(record, (state) =>
        clankerStepFailed(state, {
          stepName,
          attempt,
          reason: `Step timed out after ${state.stepsByName.get(stepName)?.timeout ?? "?"}s.`,
        }),
      );

    const writePromptFile = Effect.fn("ClankerRunService.writePromptFile")(function* (
      record: RunRecord,
      action: Extract<ClankerEngineAction, { type: "dispatchPrompt" }>,
    ) {
      const stepSlug = action.stepName.replaceAll(PROMPT_FILE_UNSAFE_CHARS, "_") || "step";
      // Clanker names `<step>-<epochMs>.md`; the pair ordinals keep same-step
      // pairs dispatched in the same millisecond from overwriting each other.
      const fileName = `${stepSlug}-${action.attempt}-${action.promptIndex}-${action.modelIndex}-${DateTime.toEpochMillis(yield* DateTime.now)}.md`;
      yield* writeFileAtomic(
        path.join(record.workspaceRoot, PROMPTS_DIR_RELATIVE, fileName),
        action.renderedPrompt,
      );
    });

    const runPromptAction = Effect.fn("ClankerRunService.runPromptAction")(function* (
      record: RunRecord,
      action: Extract<ClankerEngineAction, { type: "dispatchPrompt" }>,
    ) {
      const stepLock = yield* stepLockFor(record, action.stepName);
      yield* stepLock.withPermits(1)(
        Effect.gen(function* () {
          const declaredOutputs =
            record.state.stepStates.get(action.stepName)?.declaredOutputs ?? {};
          const outcome = yield* withStepTimeout(
            record,
            action.stepName,
            executor.runPromptTurn({
              runId: record.runId,
              projectId: record.projectId,
              stepName: action.stepName,
              attempt: action.attempt,
              promptIndex: action.promptIndex,
              modelIndex: action.modelIndex,
              renderedPrompt: action.renderedPrompt,
              threadId: record.stepThreads.get(action.stepName),
              threadTitle: `clanker:${record.workflowName}:${action.stepName}`,
              modelSelection: record.modelSelection,
              runtimeMode: record.runtimeMode,
              interactionMode: record.interactionMode,
            }),
          );
          if (outcome.type === "timedOut") {
            yield* stepTimedOut(record, action.stepName, action.attempt);
            return;
          }
          const turnOutcome = outcome.value;
          const turnThreadId = turnOutcome.threadId;
          if (turnThreadId !== undefined) {
            // The map mutation and the sidecar write must serialize under the
            // run's transition mutex: parallel steps otherwise read-modify-write
            // t3-threads.json over each other and lose entries.
            yield* record.transitions
              .withPermits(1)(
                Effect.gen(function* () {
                  record.stepThreads.set(action.stepName, turnThreadId);
                  yield* writeStepThreads(record);
                }),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Unable to persist clanker step threads", {
                    runId: record.runId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
          }
          const failed = turnOutcome.error !== undefined;
          // Clanker verifies declared outputs regardless of the pair's
          // outcome (step-runner.ts:237): a failed turn may still have left
          // the files behind, so verify what exists either way.
          const outputs = yield* verifiedOutputs(record, declaredOutputs);
          yield* settle(record, (state) =>
            clankerPromptSettled(state, {
              stepName: action.stepName,
              attempt: action.attempt,
              promptIndex: action.promptIndex,
              modelIndex: action.modelIndex,
              outputs,
              ...(failed
                ? { error: turnOutcome.error }
                : { response: turnOutcome.responseText ?? "" }),
            }),
          );
        }),
      );
    });

    const runCmdAction = Effect.fn("ClankerRunService.runCmdAction")(function* (
      record: RunRecord,
      action: Extract<ClankerEngineAction, { type: "runCmd" }>,
    ) {
      const outcome = yield* withStepTimeout(
        record,
        action.stepName,
        executor.runCommand({
          runId: record.runId,
          stepName: action.stepName,
          cmd: action.cmd,
          env: action.env,
          cwd: record.workspaceRoot,
        }),
      );
      if (outcome.type === "timedOut") {
        yield* stepTimedOut(record, action.stepName, action.attempt);
        return;
      }
      const commandOutcome = outcome.value;
      yield* settle(record, (state) =>
        action.kind === "hook"
          ? clankerCmdHookSettled(state, {
              stepName: action.stepName,
              attempt: action.attempt,
              phase: action.phase ?? "before",
              hookIndex: action.hookIndex ?? 0,
              exitCode: commandOutcome.exitCode,
              ...(commandOutcome.error === undefined ? {} : { error: commandOutcome.error }),
            })
          : clankerQaCheckSettled(state, {
              stepName: action.stepName,
              attempt: action.attempt,
              checkIndex: action.checkIndex ?? 0,
              exitCode: commandOutcome.exitCode,
              ...(commandOutcome.error === undefined ? {} : { error: commandOutcome.error }),
            }),
      );
    });

    const finishRun = Effect.fn("ClankerRunService.finishRun")(function* (
      record: RunRecord,
      result: ClankerRunResult,
    ) {
      yield* writeFileAtomic(
        path.join(record.runDirAbs, "result.json"),
        encodeRunResult({ ...result, runId: record.runId }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Unable to write clanker run result", {
            runId: record.runId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      // Closing the scope interrupts any action fibers still in flight; the
      // executor's interrupt hook then cancels their provider turns. The
      // close is forked off the transition mutex: it waits on fibers that may
      // be parked on this same mutex, so awaiting it here would deadlock.
      yield* Scope.close(record.scope, Exit.void).pipe(Effect.forkIn(serviceScope), Effect.asVoid);
      yield* runsMutex.withPermits(1)(Effect.sync(() => runs.delete(record.runId)));
    });

    /**
     * An action fiber's failure must not wedge the run: interruption means the
     * run was cancelled or the service is shutting down (drop it), while a
     * defect settles the step as a hard failure so the run keeps moving.
     */
    const supervise = <A, E, R>(
      record: RunRecord,
      stepName: string,
      attempt: number,
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Clanker run action failed", {
                runId: record.runId,
                stepName,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  settle(record, (state) =>
                    clankerStepFailed(state, {
                      stepName,
                      attempt,
                      reason: "The clanker runner hit an internal error.",
                    }),
                  ).pipe(Effect.ignoreCause({ log: true })),
                ),
              ),
        ),
      );

    const dispatchActions = Effect.fnUntraced(function* (
      record: RunRecord,
      actions: ReadonlyArray<ClankerEngineAction>,
    ) {
      for (const action of actions) {
        switch (action.type) {
          case "dispatchPrompt": {
            yield* writePromptFile(record, action).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Unable to record clanker prompt", {
                  runId: record.runId,
                  stepName: action.stepName,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
            yield* supervise(
              record,
              action.stepName,
              action.attempt,
              runPromptAction(record, action),
            ).pipe(Effect.forkIn(record.scope), Effect.asVoid);
            break;
          }
          case "runCmd": {
            yield* supervise(
              record,
              action.stepName,
              action.attempt,
              runCmdAction(record, action),
            ).pipe(Effect.forkIn(record.scope), Effect.asVoid);
            break;
          }
          case "runCompleted": {
            yield* finishRun(record, action.result);
            break;
          }
          default:
            // stepPassed/stepFailed/stepSkipped are already reflected in the
            // persisted snapshot.
            break;
        }
      }
    });

    /**
     * Apply a transition under the run mutex: snapshot the engine state,
     * persist it, then fork the emitted actions.
     */
    const applyTransition = (
      record: RunRecord,
      transition: ClankerEngineTransition,
    ): Effect.Effect<void, ClankerRunIoError> =>
      Effect.gen(function* () {
        record.state = transition.state;
        record.updatedAt = yield* nowIso;
        yield* persistState(record);
        yield* dispatchActions(record, transition.actions);
        yield* notifyChanged(record.projectId);
      });

    const settle = (
      record: RunRecord,
      transition: (state: ClankerEngineState) => ClankerEngineTransition,
    ) =>
      record.transitions.withPermits(1)(
        applyTransition(record, transition(record.state)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Unable to apply clanker run transition", {
              runId: record.runId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );

    const spawnRun = Effect.fn("ClankerRunService.spawnRun")(function* (input: {
      readonly projectId: ProjectId;
      readonly runId: ClankerRunId;
      readonly workspaceRoot: string;
      readonly workflowName: string;
      readonly workflowPath: ClankerWorkflowPath;
      readonly workflowDirAbs: string;
      readonly startedAt: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly transition: ClankerEngineTransition;
      readonly stepThreads?: ReadonlyMap<string, ThreadId> | undefined;
    }) {
      const scope = yield* Scope.make();
      const record: RunRecord = {
        runId: input.runId,
        projectId: input.projectId,
        workflowName: input.workflowName,
        workflowPath: input.workflowPath,
        workflowDirAbs: input.workflowDirAbs,
        runDirAbs: path.join(input.workspaceRoot, ".clanker", "runs", input.runId),
        workspaceRoot: input.workspaceRoot,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        state: input.transition.state,
        stepThreads: new Map(input.stepThreads ?? []),
        transitions: yield* Semaphore.make(1),
        stepLocks: new Map(),
        scope,
      };
      // One running run per workflow path: the in-memory check serializes
      // concurrent starts, the disk check catches orphans.
      yield* runsMutex.withPermits(1)(
        Effect.gen(function* () {
          const conflict = [...runs.values()].find(
            (candidate) =>
              candidate.projectId === input.projectId &&
              candidate.workflowPath === input.workflowPath &&
              candidate.state.status === "running",
          );
          if (conflict !== undefined) {
            return yield* new ClankerRunAlreadyRunningError({
              workflowPath: input.workflowPath,
              runId: conflict.runId,
            });
          }
          runs.set(input.runId, record);
        }),
      );
      // The initial persist propagates: a run that cannot write state.json
      // never starts. Any failure (or interrupt) before that first commit
      // removes the record — a "running" zombie here would block every
      // future start of the same workflow.
      yield* record.transitions
        .withPermits(1)(
          Effect.gen(function* () {
            yield* persistState(record);
            yield* dispatchActions(record, input.transition.actions);
          }),
        )
        .pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.andThen(
                  runsMutex.withPermits(1)(Effect.sync(() => runs.delete(record.runId))),
                  Scope.close(record.scope, exit),
                ),
          ),
        );
      yield* notifyChanged(input.projectId);
      return record;
    });

    /** Resolve `file:` prompt contents, keyed by the raw path as written. */
    const collectPromptFiles = Effect.fn("ClankerRunService.collectPromptFiles")(function* (
      workflow: ClankerWorkflow,
      workspaceRoot: string,
      workflowDirRelative: string,
    ) {
      const files: Record<string, string> = {};
      const seen = new Set<string>();
      for (const step of workflow.steps) {
        for (const prompt of step.prompts ?? []) {
          if (!("file" in prompt) || seen.has(prompt.file)) continue;
          seen.add(prompt.file);
          const resolved = yield* workspacePaths
            .resolveRelativePathWithinRoot({
              workspaceRoot,
              relativePath: `${workflowDirRelative}/${prompt.file}`,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          if (resolved === undefined) continue;
          const content = yield* fileSystem
            .readFileString(resolved.absolutePath)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (content !== undefined) files[prompt.file] = content;
        }
      }
      return files;
    });

    /**
     * Clanker feeds `secrets` (names resolved from its env file) into the run
     * env; here they resolve from the server's process environment.
     */
    const workflowEnv = (workflow: { readonly secrets?: ReadonlyArray<string> | undefined }) => {
      const env: Record<string, string> = {};
      for (const name of workflow.secrets ?? []) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      return env;
    };

    const requireModelSelection = Effect.fn("ClankerRunService.requireModelSelection")(function* (
      runId: ClankerRunId,
      defaultModelSelection: ModelSelection | null,
      overrides: {
        readonly providerInstanceId?: ProviderInstanceId | undefined;
        readonly model?: string | undefined;
      },
    ) {
      const instanceId = overrides.providerInstanceId ?? defaultModelSelection?.instanceId;
      if (instanceId === undefined) {
        return yield* new ClankerRunInvalidStateError({
          runId,
          detail:
            "No provider instance is configured for this project; pass providerInstanceId or set a project default model.",
        });
      }
      const model =
        overrides.model ??
        (overrides.providerInstanceId === undefined ? defaultModelSelection?.model : undefined) ??
        "default";
      return { instanceId, model } satisfies ModelSelection;
    });

    /**
     * Modes for the run's step threads: explicit input wins (an MCP caller's
     * already limit-resolved modes); otherwise the project's effective
     * defaults, the same place the composer and bootstrap thread read them.
     */
    const resolveRunModes = Effect.fn("ClankerRunService.resolveRunModes")(function* (
      projectId: ProjectId,
      shell: OrchestrationProjectShell,
      overrides: {
        readonly runtimeMode?: RuntimeMode | undefined;
        readonly interactionMode?: ProviderInteractionMode | undefined;
      },
    ) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => ioError("settings.json", cause)),
      );
      return {
        runtimeMode:
          overrides.runtimeMode ??
          resolveProjectSettings(settings, projectId, shell).settings.defaultRuntimeMode,
        interactionMode: overrides.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      };
    });

    const loadWorkflow = Effect.fn("ClankerRunService.loadWorkflow")(function* (
      projectId: ProjectId,
      workflowPath: ClankerWorkflowPath,
      runId: ClankerRunId,
    ) {
      const document = yield* workflows.get({ projectId, path: workflowPath });
      const parsed = parseClankerWorkflow(document.content);
      if (parsed.workflow === undefined) {
        return yield* new ClankerRunInvalidStateError({
          runId,
          detail: `Workflow '${workflowPath}' does not parse: ${parsed.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; ")}`,
        });
      }
      return parsed.workflow;
    });

    const toDetail = (
      projectId: ProjectId,
      runId: ClankerRunId,
      persisted: ClankerPersistedRunState,
      stepThreads: ReadonlyMap<string, ThreadId>,
    ): ClankerRunDetail => ({
      runId,
      projectId,
      workflowName: persisted.workflowName,
      ...(persisted.workflowPath === undefined || persisted.workflowPath.trim().length === 0
        ? {}
        : { workflowPath: ClankerWorkflowPath.make(persisted.workflowPath) }),
      startedAt: persisted.startedAt,
      updatedAt: persisted.updatedAt,
      status: persisted.status,
      steps: persisted.steps,
      stepThreads: [...stepThreads.entries()].map(
        ([stepName, threadId]) => ({ stepName, threadId }) satisfies ClankerStepThread,
      ),
    });

    const list: ClankerRunService["Service"]["list"] = Effect.fn("ClankerRunService.list")(
      function* (input) {
        const shell = yield* workspaceShellFor(input.projectId);
        if (shell === null) return [];
        return yield* listForRoot(shell.workspaceRoot);
      },
    );

    const subscribe: ClankerRunService["Service"]["subscribe"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the snapshot so a change landing between the two
          // is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const resnapshot = list(input);
          return Stream.concat(
            Stream.fromEffect(resnapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((projectId) => projectId === input.projectId),
              Stream.mapEffect(() => list(input)),
            ),
          );
        }),
      );

    const get: ClankerRunService["Service"]["get"] = Effect.fn("ClankerRunService.get")(
      function* (input) {
        const record = runs.get(input.runId);
        if (record !== undefined) {
          if (record.projectId !== input.projectId) {
            return yield* new ClankerRunNotFoundError({ runId: input.runId });
          }
          const persisted = clankerRunToPersistedState(record.state, {
            runId: record.runId,
            ...(record.workflowPath === undefined ? {} : { workflowPath: record.workflowPath }),
            startedAt: record.startedAt,
            updatedAt: record.updatedAt,
          });
          return toDetail(input.projectId, input.runId, persisted, record.stepThreads);
        }
        const shell = yield* workspaceShellFor(input.projectId);
        if (shell === null) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        const runDirAbs = yield* runDirFor(shell.workspaceRoot, input.runId);
        const persisted = yield* readPersistedState(runDirAbs);
        if (persisted === undefined) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        const stepThreads = yield* readStepThreads(runDirAbs);
        return toDetail(input.projectId, input.runId, persisted, stepThreads);
      },
    );

    const start: ClankerRunService["Service"]["start"] = Effect.fn("ClankerRunService.start")(
      function* (input) {
        const runId = ClankerRunId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
        const workflow = yield* loadWorkflow(input.projectId, input.workflowPath, runId);
        const shell = yield* workspaceShellFor(input.projectId);
        if (shell === null) {
          return yield* new ClankerWorkflowReadError({
            path: input.workflowPath,
            cause: `Project ${input.projectId} was not found.`,
          });
        }
        const modelSelection = yield* requireModelSelection(runId, shell.defaultModelSelection, {
          providerInstanceId: input.providerInstanceId,
          model: input.model,
        });
        const modes = yield* resolveRunModes(input.projectId, shell, input);
        const workflowDirRelative = dirnamePosix(input.workflowPath);
        const files = yield* collectPromptFiles(workflow, shell.workspaceRoot, workflowDirRelative);
        const transition = startClankerRun(workflow, {
          env: workflowEnv(workflow),
          files,
          ...(input.startFromStep === undefined ? {} : { startFromStep: input.startFromStep }),
        });
        yield* spawnRun({
          projectId: input.projectId,
          runId,
          workspaceRoot: shell.workspaceRoot,
          workflowName: workflow.name,
          workflowPath: input.workflowPath,
          workflowDirAbs: path.join(shell.workspaceRoot, workflowDirRelative),
          startedAt: yield* nowIso,
          modelSelection,
          ...modes,
          transition,
        });
        return { runId };
      },
    );

    const cancel: ClankerRunService["Service"]["cancel"] = Effect.fn("ClankerRunService.cancel")(
      function* (input) {
        const record = runs.get(input.runId);
        if (record !== undefined) {
          if (record.projectId !== input.projectId) {
            return yield* new ClankerRunNotFoundError({ runId: input.runId });
          }
          yield* settle(record, (state) => cancelClankerRun(state));
          return;
        }
        const shell = yield* workspaceShellFor(input.projectId);
        if (shell === null) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        const runDirAbs = yield* runDirFor(shell.workspaceRoot, input.runId);
        const persisted = yield* readPersistedState(runDirAbs);
        if (persisted === undefined) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        if (persisted.status !== "running") return;
        // Orphaned run (a previous server process): mark it cancelled on disk.
        yield* writeFileAtomic(
          path.join(runDirAbs, "state.json"),
          encodePersistedState({
            ...persisted,
            status: "cancelled",
            updatedAt: yield* nowIso,
          }),
        );
        yield* notifyChanged(input.projectId);
      },
    );

    const resume: ClankerRunService["Service"]["resume"] = Effect.fn("ClankerRunService.resume")(
      function* (input) {
        const live = runs.get(input.runId);
        if (live !== undefined) {
          if (live.projectId !== input.projectId) {
            return yield* new ClankerRunNotFoundError({ runId: input.runId });
          }
          return yield* new ClankerRunInvalidStateError({
            runId: input.runId,
            detail: "The run is still running.",
          });
        }
        const shell = yield* workspaceShellFor(input.projectId);
        if (shell === null) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        const runDirAbs = yield* runDirFor(shell.workspaceRoot, input.runId);
        const persisted = yield* readPersistedState(runDirAbs);
        if (persisted === undefined) {
          return yield* new ClankerRunNotFoundError({ runId: input.runId });
        }
        if (persisted.status === "completed") {
          return yield* new ClankerRunInvalidStateError({
            runId: input.runId,
            detail: "The run already completed.",
          });
        }
        if (persisted.workflowPath === undefined || persisted.workflowPath.trim().length === 0) {
          return yield* new ClankerRunInvalidStateError({
            runId: input.runId,
            detail: "The run does not record its workflow path.",
          });
        }
        const workflowPath = ClankerWorkflowPath.make(persisted.workflowPath);
        const workflow = yield* loadWorkflow(input.projectId, workflowPath, input.runId);
        const waves = buildClankerWaves(workflow.steps).waves;
        const restoredSteps: Array<ClankerRestoredStep> = [];
        for (const [name, step] of Object.entries(persisted.steps)) {
          if (step.status !== "passed" && step.status !== "skipped") continue;
          restoredSteps.push({
            name,
            status: step.status,
            outputs: step.outputs,
            declaredOutputs: step.declaredOutputs,
            responses: step.responses,
            retryCount: step.retryCount,
            ...(step.error === undefined ? {} : { error: step.error }),
          });
        }
        // The resume gate: before `startFromStep` is reached in wave order,
        // restored steps are restored and un-restored ones still run. Default
        // to the first step that did not pass or skip.
        const startFromStep =
          input.startFromStep ??
          waves.flat().find((name) => {
            const status = persisted.steps[name]?.status;
            return status !== "passed" && status !== "skipped";
          });
        if (startFromStep === undefined) {
          return yield* new ClankerRunInvalidStateError({
            runId: input.runId,
            detail: "Every step already passed or was skipped.",
          });
        }
        const modelSelection = yield* requireModelSelection(
          input.runId,
          shell.defaultModelSelection,
          {},
        );
        const modes = yield* resolveRunModes(input.projectId, shell, input);
        const workflowDirRelative = dirnamePosix(workflowPath);
        const files = yield* collectPromptFiles(workflow, shell.workspaceRoot, workflowDirRelative);
        const transition = startClankerRun(workflow, {
          env: workflowEnv(workflow),
          files,
          startFromStep,
          restoredSteps,
        });
        const stepThreads = yield* readStepThreads(runDirAbs);
        yield* spawnRun({
          projectId: input.projectId,
          runId: input.runId,
          workspaceRoot: shell.workspaceRoot,
          workflowName: workflow.name,
          workflowPath,
          workflowDirAbs: path.join(shell.workspaceRoot, workflowDirRelative),
          startedAt: persisted.startedAt,
          modelSelection,
          ...modes,
          transition,
          stepThreads,
        });
        return { runId: input.runId };
      },
    );

    return ClankerRunService.of({ list, get, subscribe, start, cancel, resume });
  }),
);

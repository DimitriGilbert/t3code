import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ClankerRunId,
  ClankerWorkflowPath,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClankerRunStatus,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { ClankerPersistedRunState } from "@t3tools/clanker/runState";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ClankerRunExecutor,
  ClankerRunService,
  layer as clankerRunServiceLayer,
  type ClankerPromptTurnInput,
  type ClankerPromptTurnOutcome,
  type ClankerRunCommandInput,
  type ClankerRunCommandOutcome,
} from "./ClankerRunService.ts";
import { ClankerWorkflowService } from "./ClankerWorkflowService.ts";

const projectId = ProjectId.make("project-1");
const workflowPath = ClankerWorkflowPath.make(".clanker/workflows/flow.yaml");

let workspaceRoot: string | null = null;
let workflowContent = "";

const turnCalls = Effect.runSync(
  Queue.unbounded<{
    input: ClankerPromptTurnInput;
    gate: Deferred.Deferred<ClankerPromptTurnOutcome>;
  }>(),
);
const commandCalls = Effect.runSync(
  Queue.unbounded<{
    input: ClankerRunCommandInput;
    gate: Deferred.Deferred<ClankerRunCommandOutcome>;
  }>(),
);

/** Suspend the call until the test answers it; interruptible for cancel tests. */
const gatedCall = <A, I>(queue: Queue.Queue<{ input: I; gate: Deferred.Deferred<A> }>, input: I) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<A>();
    yield* Queue.offer(queue, { input, gate });
    return yield* Deferred.await(gate);
  });

const nextTurn = Queue.take(turnCalls);
const nextCommand = Queue.take(commandCalls);

const answerTurn = (
  call: { input: ClankerPromptTurnInput; gate: Deferred.Deferred<ClankerPromptTurnOutcome> },
  outcome: Omit<ClankerPromptTurnOutcome, "threadId"> & { threadId?: string },
) =>
  Deferred.succeed(call.gate, {
    threadId: ThreadId.make(outcome.threadId ?? `thread-${call.input.stepName}`),
    ...(outcome.responseText === undefined ? {} : { responseText: outcome.responseText }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  });

const answerCommand = (
  call: { input: ClankerRunCommandInput; gate: Deferred.Deferred<ClankerRunCommandOutcome> },
  outcome: ClankerRunCommandOutcome,
) => Deferred.succeed(call.gate, outcome);

const shellFor = (root: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot: root,
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("instance-1"),
    model: "default",
  },
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(clankerRunServiceLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () =>
        Effect.succeed(
          workspaceRoot === null ? Option.none() : Option.some(shellFor(workspaceRoot)),
        ),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ClankerWorkflowService)({
      get: () =>
        Effect.succeed({
          path: workflowPath,
          content: workflowContent,
          diagnostics: [],
          waves: [],
        }),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ClankerRunExecutor)({
      runPromptTurn: (input) => gatedCall(turnCalls, input),
      runCommand: (input) => gatedCall(commandCalls, input),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const useWorkspace = Effect.fn("useWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-clanker-runs-",
  });
  yield* fileSystem.makeDirectory(`${workspaceRoot}/.clanker/workflows`, { recursive: true });
  yield* fileSystem.writeFileString(
    `${workspaceRoot}/.clanker/workflows/flow.yaml`,
    workflowContent,
  );
  return workspaceRoot;
});

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(ClankerPersistedRunState));
const decodeStepThreads = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ steps: Schema.Record(Schema.String, Schema.String) })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const readState = Effect.fn("readState")(function* (runId: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const content = yield* fileSystem.readFileString(
    `${workspaceRoot}/.clanker/runs/${runId}/state.json`,
  );
  return decodeState(content);
});

/**
 * The service's dirty-pubsub subscription drives this: each transition
 * re-lists, so waiting for a status is event-driven, never a poll.
 */
const awaitStatus = Effect.fn("awaitStatus")(function* (
  service: ClankerRunService["Service"],
  runId: string,
  status: ClankerRunStatus,
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(service.subscribe({ projectId }));
      while (true) {
        const chunk = yield* pull;
        for (const summaries of chunk) {
          const found = summaries.find((entry) => entry.runId === runId);
          if (found?.status === status) return;
        }
      }
    }),
  );
});

const twoStepYaml = `name: flow
version: "1.0.0"
steps:
  - name: first
    prompts:
      - text: do first
  - name: second
    depends_on: [first]
    prompts:
      - text: do second
`;

it.layer(layerTest)("ClankerRunService", (it) => {
  describe("start", () => {
    it.effect("runs waves in order and writes a schema-decodable state.json", () =>
      Effect.gen(function* () {
        workflowContent = twoStepYaml;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        const first = yield* nextTurn;
        expect(first.input.stepName).toBe("first");
        expect(first.input.renderedPrompt).toBe("do first");
        expect(first.input.modelSelection).toEqual({
          instanceId: "instance-1",
          model: "default",
        });
        // ws starts resolve the environment default modes for step threads.
        expect(first.input.runtimeMode).toBe("full-access");
        expect(first.input.interactionMode).toBe("default");
        yield* answerTurn(first, { responseText: "first done" });

        const second = yield* nextTurn;
        expect(second.input.stepName).toBe("second");
        yield* answerTurn(second, { responseText: "second done" });

        yield* awaitStatus(service, runId, "completed");

        const state = yield* readState(runId);
        expect(state.status).toBe("completed");
        expect(state.steps.first?.status).toBe("passed");
        expect(state.steps.second?.status).toBe("passed");
        expect(state.steps.second?.responses[0]?.response).toBe("second done");

        const detail = yield* service.get({ projectId, runId });
        expect(detail.status).toBe("completed");
        expect(detail.stepThreads).toEqual([
          { stepName: "first", threadId: "thread-first" },
          { stepName: "second", threadId: "thread-second" },
        ]);

        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(`${root}/.clanker/runs/${runId}/result.json`)).toBe(true);
        const prompts = yield* fileSystem.readDirectory(`${root}/.clanker/prompts`);
        expect(prompts.filter((entry) => entry.startsWith("first-"))).toHaveLength(1);
      }),
    );

    it.effect("dispatches parallel wave steps on separate threads", () =>
      Effect.gen(function* () {
        workflowContent = `name: flow
version: "1.0.0"
steps:
  - name: alpha
    prompts:
      - text: do a
  - name: beta
    prompts:
      - text: do b
`;
        const service = yield* ClankerRunService;
        yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        const first = yield* nextTurn;
        const second = yield* nextTurn;
        expect([first.input.stepName, second.input.stepName].sort()).toEqual(["alpha", "beta"]);
        yield* answerTurn(first, {
          threadId: `thread-${first.input.stepName}`,
          responseText: "a",
        });
        yield* answerTurn(second, {
          threadId: `thread-${second.input.stepName}`,
          responseText: "b",
        });

        yield* awaitStatus(service, runId, "completed");
        const detail = yield* service.get({ projectId, runId });
        expect(detail.stepThreads).toHaveLength(2);
      }),
    );

    it.effect("persists every parallel step's thread in t3-threads.json", () =>
      Effect.gen(function* () {
        workflowContent = `name: flow
version: "1.0.0"
steps:
  - name: one
    prompts:
      - text: do 1
  - name: two
    prompts:
      - text: do 2
  - name: three
    prompts:
      - text: do 3
  - name: four
    prompts:
      - text: do 4
`;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        // All four gated turns land at once, so their sidecar read-modify-write
        // cycles race: a lost update drops a step's thread entry.
        const calls = yield* Effect.all([nextTurn, nextTurn, nextTurn, nextTurn]);
        yield* Effect.forEach(
          calls,
          (call) =>
            answerTurn(call, {
              threadId: `thread-${call.input.stepName}`,
              responseText: "ok",
            }),
          { concurrency: "unbounded" },
        );

        yield* awaitStatus(service, runId, "completed");

        const fileSystem = yield* FileSystem.FileSystem;
        const sidecar = decodeStepThreads(
          yield* fileSystem.readFileString(`${root}/.clanker/runs/${runId}/t3-threads.json`),
        );
        for (const call of calls) {
          expect(sidecar.steps[call.input.stepName]).toBe(`thread-${call.input.stepName}`);
        }
      }),
    );

    it.effect("serializes a step's prompt pairs as follow-up turns in one thread", () =>
      Effect.gen(function* () {
        workflowContent = `name: flow
version: "1.0.0"
steps:
  - name: only
    prompts:
      - text: prompt one
      - text: prompt two
`;
        const service = yield* ClankerRunService;
        yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        const first = yield* nextTurn;
        expect(first.input.promptIndex).toBe(0);
        expect(first.input.threadId).toBeUndefined();
        yield* answerTurn(first, { threadId: "the-thread", responseText: "one" });

        const second = yield* nextTurn;
        expect(second.input.promptIndex).toBe(1);
        expect(second.input.threadId).toBe("the-thread");
        yield* answerTurn(second, { responseText: "two" });

        yield* awaitStatus(service, runId, "completed");
        const state = yield* readState(runId);
        expect(state.steps.only?.responses).toHaveLength(2);
      }),
    );

    it.effect("runs cmd hooks through the command executor before prompts", () =>
      Effect.gen(function* () {
        workflowContent = `name: flow
version: "1.0.0"
steps:
  - name: hooked
    hooks:
      before:
        - cmd: echo ready
    prompts:
      - text: go
`;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        const hook = yield* nextCommand;
        expect(hook.input.cmd).toBe("echo ready");
        expect(hook.input.cwd).toBe(root);
        yield* answerCommand(hook, { exitCode: 0 });

        const turn = yield* nextTurn;
        yield* answerTurn(turn, { responseText: "done" });

        yield* awaitStatus(service, runId, "completed");
        const state = yield* readState(runId);
        expect(state.steps.hooked?.status).toBe("passed");
      }),
    );

    it.effect("retries the attempt when a rerun QA check fails", () =>
      Effect.gen(function* () {
        workflowContent = `name: flow
version: "1.0.0"
steps:
  - name: checked
    retry: 1
    prompts:
      - text: work
    qa:
      checks:
        - type: cmd
          cmd: verify
          on_fail: rerun
`;
        const service = yield* ClankerRunService;
        yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });

        const firstTurn = yield* nextTurn;
        yield* answerTurn(firstTurn, { responseText: "draft" });
        const firstCheck = yield* nextCommand;
        expect(firstCheck.input.cmd).toBe("verify");
        yield* answerCommand(firstCheck, { exitCode: 1, error: "not good" });

        const secondTurn = yield* nextTurn;
        expect(secondTurn.input.attempt).toBe(1);
        expect(secondTurn.input.threadId).toBe("thread-checked");
        yield* answerTurn(secondTurn, { responseText: "fixed" });
        const secondCheck = yield* nextCommand;
        yield* answerCommand(secondCheck, { exitCode: 0 });

        yield* awaitStatus(service, runId, "completed");
        const state = yield* readState(runId);
        expect(state.steps.checked?.retryCount).toBe(1);
        expect(state.steps.checked?.responses[0]?.response).toBe("fixed");
      }),
    );
  });

  describe("cancel", () => {
    it.effect("marks the run cancelled and writes result.json", () =>
      Effect.gen(function* () {
        workflowContent = twoStepYaml;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();

        const { runId } = yield* service.start({ projectId, workflowPath });
        yield* nextTurn; // in-flight, never answered

        yield* service.cancel({ projectId, runId });

        const state = yield* readState(runId);
        expect(state.status).toBe("cancelled");

        const fileSystem = yield* FileSystem.FileSystem;
        const result = decodeResultJson(
          yield* fileSystem.readFileString(`${root}/.clanker/runs/${runId}/result.json`),
        );
        expect(result.cancelled).toBe(true);

        const detail = yield* service.get({ projectId, runId });
        expect(detail.status).toBe("cancelled");
      }),
    );
  });

  describe("resume", () => {
    it.effect("restores passed steps and only runs the remainder", () =>
      Effect.gen(function* () {
        workflowContent = twoStepYaml;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();
        const fileSystem = yield* FileSystem.FileSystem;

        const priorRunId = "run-prior";
        const persisted = {
          runId: priorRunId,
          workflowName: "flow",
          workflowPath,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "failed",
          steps: {
            first: {
              status: "passed",
              retryCount: 0,
              responses: [{ prompt_index: 0, model_id: "default", response: "first done" }],
              declaredOutputs: { plan: "plan.md" },
              outputs: { plan: "plan.md" },
            },
            second: {
              status: "failed",
              retryCount: 0,
              responses: [],
              declaredOutputs: {},
              outputs: {},
              error: "boom",
            },
          },
        };
        yield* fileSystem.makeDirectory(`${root}/.clanker/runs/${priorRunId}`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          `${root}/.clanker/runs/${priorRunId}/state.json`,
          encodeJson(persisted),
        );

        yield* service.resume({ projectId, runId: ClankerRunId.make(priorRunId) });

        const turn = yield* nextTurn;
        expect(turn.input.stepName).toBe("second");
        yield* answerTurn(turn, { responseText: "second done" });

        yield* awaitStatus(service, priorRunId, "completed");
        const state = yield* readState(priorRunId);
        expect(state.steps.first?.status).toBe("passed");
        expect(state.steps.first?.outputs).toEqual({ plan: "plan.md" });
        expect(state.steps.second?.status).toBe("passed");
      }),
    );
  });

  describe("list", () => {
    it.effect("summarizes runs and skips corrupt state files", () =>
      Effect.gen(function* () {
        workflowContent = twoStepYaml;
        const service = yield* ClankerRunService;
        const root = yield* useWorkspace();
        const fileSystem = yield* FileSystem.FileSystem;

        yield* fileSystem.makeDirectory(`${root}/.clanker/runs/corrupt`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/.clanker/runs/corrupt/state.json`, "{nope");

        const { runId } = yield* service.start({ projectId, workflowPath });
        yield* answerTurn(yield* nextTurn, { responseText: "a" });
        yield* answerTurn(yield* nextTurn, { responseText: "b" });
        yield* awaitStatus(service, runId, "completed");

        const listed = yield* service.list({ projectId });
        expect(listed).toHaveLength(1);
        const summary = listed[0];
        expect(summary?.status).toBe("completed");
        expect(summary?.stepTotal).toBe(2);
        expect(summary?.passedSteps).toBe(2);

        // Unknown run ids and escape attempts both report not-found.
        for (const bad of ["missing", "../escape", "a/b"]) {
          const error = yield* service
            .get({ projectId, runId: ClankerRunId.make(bad) })
            .pipe(Effect.flip);
          expect(error._tag).toBe("ClankerRunNotFoundError");
        }
      }),
    );
  });
});

const decodeResultJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ cancelled: Schema.Boolean })),
);

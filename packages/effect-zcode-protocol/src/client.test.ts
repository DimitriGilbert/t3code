import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as ZCodeClient from "./client.ts";
import * as ZCodeError from "./errors.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const storageReady = (attemptId = "a1", sequence = 1) => ({
  method: "startup/storageState",
  params: {
    schemaVersion: 1,
    attemptId,
    sequence,
    databaseId: "db-1",
    databaseKind: "session",
    phase: "ready",
    elapsedMs: 5,
  },
});

it.layer(NodeServices.layer)("effect-zcode-protocol client", (it) => {
  it.effect("correlates responses by id and decodes typed results", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* ZCodeClient.make(stdio, { requireStorageStartup: false });

      const pending = yield* client
        .request("v4/conversation/subscribe", {
          topic: "workspace-config//tmp",
          connectionId: "t3-test-1",
          clientMode: "desktop-continuous",
        })
        .pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "v4/conversation/subscribe",
        params: {
          topic: "workspace-config//tmp",
          connectionId: "t3-test-1",
          clientMode: "desktop-continuous",
        },
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: { ack: { subscriptionId: "sub-9", mode: "snapshot", logEpoch: "e1" } },
        }),
      );
      assert.deepEqual(yield* Fiber.join(pending), {
        ack: { subscriptionId: "sub-9", mode: "snapshot", logEpoch: "e1" },
      });
    }),
  );

  it.effect("holds requests until storageState ready, then releases them", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* ZCodeClient.make(stdio);

      const pending = yield* client
        .request("session/list", { workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" } })
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "startup/storageState",
          params: {
            schemaVersion: 1,
            attemptId: "a1",
            sequence: 1,
            databaseId: "db-1",
            databaseKind: "session",
            phase: "checking",
            elapsedMs: 2,
          },
        }),
      );
      // Still gated: nothing written yet.
      assert.equal((yield* Queue.poll(output))._tag, "None");

      yield* Queue.offer(input, encodeJsonl(storageReady("a1", 2)));
      const written = yield* decodeJson(yield* Queue.take(output));
      assert.equal((written as { method: string }).method, "session/list");

      yield* Queue.offer(input, encodeJsonl({ id: 1, result: { sessions: [] } }));
      assert.deepEqual(yield* Fiber.join(pending), { sessions: [] });
    }),
  );

  it.effect("lets requests through before any storage frame when not required", () =>
    Effect.gen(function* () {
      const { stdio, output } = yield* makeInMemoryStdio();
      const client = yield* ZCodeClient.make(stdio, { requireStorageStartup: false });
      yield* client.notify("v4/connection/flow", { connectionId: "c1", state: "drained" });
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        method: "v4/connection/flow",
        params: { connectionId: "c1", state: "drained" },
      });
    }),
  );

  it.effect("fails queued and future requests on a failed storage phase", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* ZCodeClient.make(stdio);
      const pending = yield* client.request("session/list", {}).pipe(Effect.forkScoped);
      // checking → waiting; a second queued request joins the waiters.
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "startup/storageState",
          params: {
            schemaVersion: 1,
            attemptId: "a1",
            sequence: 1,
            databaseId: "db-1",
            databaseKind: "session",
            phase: "checking",
            elapsedMs: 1,
          },
        }),
      );
      const second = yield* client.request("session/list", {}).pipe(Effect.forkScoped);
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "startup/storageState",
          params: {
            schemaVersion: 1,
            attemptId: "a1",
            sequence: 2,
            databaseId: "db-1",
            databaseKind: "session",
            phase: "failed",
            errorCode: "corrupt",
            elapsedMs: 9,
          },
        }),
      );

      const failure = yield* Fiber.join(second).pipe(Effect.flip);
      assert.instanceOf(failure, ZCodeError.ZCodeAppServerStorageStartupError);
      assert.equal(failure.errorCode, "corrupt");
      const first = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.instanceOf(first, ZCodeError.ZCodeAppServerStorageStartupError);

      const late = yield* client.request("session/list", {}).pipe(Effect.flip);
      assert.instanceOf(late, ZCodeError.ZCodeAppServerStorageStartupError);
      // Nothing was written for the rejected requests.
      assert.isNull(
        yield* Queue.poll(output).pipe(Effect.map((o) => (o._tag === "Some" ? o.value : null))),
      );
    }),
  );

  it.effect("answers server interaction requests through registered handlers", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* ZCodeClient.make(stdio, { requireStorageStartup: false });
      const seen = yield* Deferred.make<unknown>();
      yield* client.handleServerRequest("interaction/requestUserInput", (payload) =>
        Deferred.succeed(seen, payload).pipe(Effect.as({ action: "cancel" as const })),
      );

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 77,
          method: "interaction/requestUserInput",
          params: { requestId: "r1", sessionId: "s1", prompt: "Pick?" },
        }),
      );
      const payload = (yield* Deferred.await(seen)) as { requestId: string };
      assert.equal(payload.requestId, "r1");
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 77,
        result: { action: "cancel" },
      });
    }),
  );

  it.effect("responds with method-not-found for unhandled reverse requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      yield* ZCodeClient.make(stdio, { requireStorageStartup: false });
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 9,
          method: "interaction/browserExecute",
          params: { requestId: "r", sessionId: "s", command: {} },
        }),
      );
      const written = yield* decodeJson(yield* Queue.take(output));
      assert.equal((written as { error: { code: number } }).error.code, -32601);
    }),
  );
});

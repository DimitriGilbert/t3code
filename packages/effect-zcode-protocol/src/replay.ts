import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as ZCodeClient from "./client.ts";
import * as ZCodeError from "./errors.ts";

export const ZCodeAppServerReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("expect_outbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("emit_inbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
    afterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_exit"),
    status: Schema.Literals(["success", "error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type ZCodeAppServerReplayEntry = typeof ZCodeAppServerReplayEntry.Type;

export const ZCodeAppServerReplayTranscript = Schema.Struct({
  provider: Schema.Literal("zcode"),
  protocol: Schema.Literal("zcode.app-server-v4"),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ZCodeAppServerReplayEntry),
});
export type ZCodeAppServerReplayTranscript = typeof ZCodeAppServerReplayTranscript.Type;
const decodeOutboundJsonFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export class ZCodeAppServerReplayJsonParseError extends Schema.TaggedError<ZCodeAppServerReplayJsonParseError>()(
  "ZCodeAppServerReplayJsonParseError",
  { scenario: Schema.String, line: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Failed to parse outbound zcode app-server replay frame for scenario ${this.scenario}.`;
  }
}

export class ZCodeAppServerReplayExhaustedError extends Schema.TaggedError<ZCodeAppServerReplayExhaustedError>()(
  "ZCodeAppServerReplayExhaustedError",
  { scenario: Schema.String, cursor: Schema.Number, actual: Schema.Unknown },
) {
  override get message() {
    return `Zcode app-server replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ZCodeAppServerReplayUnexpectedOutboundError extends Schema.TaggedError<ZCodeAppServerReplayUnexpectedOutboundError>()(
  "ZCodeAppServerReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message() {
    return `Unexpected outbound zcode app-server frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ZCodeAppServerReplayFrameMismatchError extends Schema.TaggedError<ZCodeAppServerReplayFrameMismatchError>()(
  "ZCodeAppServerReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message() {
    return `Outbound zcode app-server frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}. Expected ${JSON.stringify(this.expected)}, received ${JSON.stringify(this.actual)}.`;
  }
}

export class ZCodeAppServerReplayRuntimeExitError extends Schema.TaggedError<ZCodeAppServerReplayRuntimeExitError>()(
  "ZCodeAppServerReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message() {
    return `Zcode app-server replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ZCodeAppServerReplayIncompleteError extends Schema.TaggedError<ZCodeAppServerReplayIncompleteError>()(
  "ZCodeAppServerReplayIncompleteError",
  { scenario: Schema.String, cursor: Schema.Number, remaining: Schema.Number },
) {
  override get message() {
    return `Zcode app-server replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export const ZCodeAppServerReplayError = Schema.Union([
  ZCodeAppServerReplayJsonParseError,
  ZCodeAppServerReplayExhaustedError,
  ZCodeAppServerReplayUnexpectedOutboundError,
  ZCodeAppServerReplayFrameMismatchError,
  ZCodeAppServerReplayRuntimeExitError,
  ZCodeAppServerReplayIncompleteError,
]);
export type ZCodeAppServerReplayError = typeof ZCodeAppServerReplayError.Type;

export interface ZCodeAppServerReplayState {
  readonly cursor: number;
  readonly failure: ZCodeAppServerReplayError | null;
}

export interface ZCodeAppServerReplayDriver {
  readonly transcript: ZCodeAppServerReplayTranscript;
  readonly state: Ref.Ref<ZCodeAppServerReplayState>;
  readonly beforeEmitInbound?: (
    entry: Extract<ZCodeAppServerReplayEntry, { readonly type: "emit_inbound" }>,
  ) => Effect.Effect<void>;
}

const encoder = new TextEncoder();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// v4/command envelopes carry a uuid-v7 commandId and a client-clock issuedAt;
// both are randomized per run, so transcript comparison masks them. The mask is
// asymmetric by design: adapter-side correlation must match on method and
// payload shape, never on commandId.
function normalizeReplayFrame(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(normalizeReplayFrame);
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, normalizeReplayFrame(entry)]),
  );
  if (
    normalized.method === "v4/command" &&
    typeof normalized.params === "object" &&
    normalized.params !== null
  ) {
    normalized.params = {
      ...(normalized.params as Record<string, unknown>),
      commandId: "<ignored>",
      issuedAt: "<ignored>",
    };
  }
  return normalized;
}

const sameFrame = (left: unknown, right: unknown): boolean =>
  stableStringify(normalizeReplayFrame(left)) === stableStringify(normalizeReplayFrame(right));

const encodeInboundFrame = (frame: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

const replayTransportError = (
  error: ZCodeAppServerReplayError,
): ZCodeError.ZCodeAppServerTransportError =>
  new ZCodeError.ZCodeAppServerTransportError({ operation: "read-input-stream", cause: error });

export function layerReplay(
  transcript: ZCodeAppServerReplayTranscript,
  options: ZCodeClient.ZCodeAppServerClientOptions = {},
): Layer.Layer<ZCodeClient.ZCodeAppServerClient, ZCodeAppServerReplayError> {
  return Layer.effect(ZCodeClient.ZCodeAppServerClient, makeReplayClient(transcript, options));
}

export const makeReplayDriver = Effect.fn("effect-zcode-protocol/replay.makeReplayDriver")(
  function* (
    transcript: ZCodeAppServerReplayTranscript,
    options: Pick<ZCodeAppServerReplayDriver, "beforeEmitInbound"> = {},
  ) {
    return {
      transcript,
      state: yield* Ref.make<ZCodeAppServerReplayState>({ cursor: 0, failure: null }),
      ...options,
    } satisfies ZCodeAppServerReplayDriver;
  },
);

export function layerReplayWithDriver(
  driver: ZCodeAppServerReplayDriver,
  options: ZCodeClient.ZCodeAppServerClientOptions = {},
): Layer.Layer<ZCodeClient.ZCodeAppServerClient, ZCodeAppServerReplayError> {
  return Layer.effect(ZCodeClient.ZCodeAppServerClient, makeReplayClientWithState(driver, options));
}

const makeReplayClient = Effect.fn("effect-zcode-protocol/replay.makeReplayClient")(function* (
  transcript: ZCodeAppServerReplayTranscript,
  options: ZCodeClient.ZCodeAppServerClientOptions = {},
) {
  const driver = yield* makeReplayDriver(transcript);
  return yield* makeReplayClientWithState(driver, options);
});

const makeReplayClientWithState = Effect.fn(
  "effect-zcode-protocol/replay.makeReplayClientWithState",
)(function* (
  driver: ZCodeAppServerReplayDriver,
  options: ZCodeClient.ZCodeAppServerClientOptions = {},
) {
  const transcript = driver.transcript;
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const state = driver.state;
  const outboundRemainder = yield* Ref.make("");
  const decoder = new TextDecoder();

  const failReplay = (error: ZCodeAppServerReplayError) =>
    Ref.update(state, (current) => ({
      ...current,
      failure: current.failure ?? error,
    })).pipe(Effect.andThen(Queue.end(input)));

  const drainInbound = Effect.fn("effect-zcode-protocol/replay.drainInbound")(function* () {
    while (true) {
      const current = yield* Ref.get(state);
      if (current.failure) return;
      const entry = transcript.entries[current.cursor];
      if (!entry) return;

      if (entry.type === "emit_inbound") {
        if (driver.beforeEmitInbound !== undefined) {
          yield* driver.beforeEmitInbound(entry);
        }
        if (entry.afterMs !== undefined && entry.afterMs > 0) {
          yield* Effect.sleep(Duration.millis(entry.afterMs));
        }
        yield* Queue.offer(input, encodeInboundFrame(entry.frame));
        yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
        continue;
      }

      if (entry.type === "runtime_exit") {
        yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
        if (entry.status === "success") {
          yield* Queue.end(input);
          return;
        }
        yield* failReplay(
          new ZCodeAppServerReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: current.cursor,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
        return;
      }

      return;
    }
  });

  const processOutboundFrame = (actual: unknown) =>
    drainInbound().pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.failure) return;
          const entry = transcript.entries[current.cursor];
          if (!entry) {
            yield* failReplay(
              new ZCodeAppServerReplayExhaustedError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                actual,
              }),
            );
            return;
          }
          if (entry.type !== "expect_outbound") {
            yield* failReplay(
              new ZCodeAppServerReplayUnexpectedOutboundError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                expectedType: entry.type,
                actual,
              }),
            );
            return;
          }
          if (!sameFrame(entry.frame, actual)) {
            yield* failReplay(
              new ZCodeAppServerReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                ...(entry.label === undefined ? {} : { label: entry.label }),
                expected: entry.frame,
                actual,
              }),
            );
            return;
          }
          yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
          yield* drainInbound();
        }),
      ),
    );

  const processOutboundLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return Effect.void;
    return Effect.try({
      try: () => decodeOutboundJsonFrame(trimmed),
      catch: (cause) =>
        new ZCodeAppServerReplayJsonParseError({
          scenario: transcript.scenario,
          line: trimmed,
          cause,
        }),
    }).pipe(Effect.matchEffect({ onFailure: failReplay, onSuccess: processOutboundFrame }));
  };

  const processOutboundChunk = (chunk: string | Uint8Array) =>
    Ref.modify(outboundRemainder, (current) => {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const combined = current + text;
      const lines = combined.split("\n");
      const nextRemainder = lines.pop() ?? "";
      return [lines.map((line) => line.replace(/\r$/, "")), nextRemainder] as const;
    }).pipe(
      Effect.flatMap((lines) => Effect.forEach(lines, processOutboundLine, { discard: true })),
    );

  const terminationError: Effect.Effect<ZCodeError.ZCodeAppServerError> = Ref.get(state).pipe(
    Effect.map((current) =>
      current.failure
        ? replayTransportError(current.failure)
        : new ZCodeError.ZCodeAppServerProcessExitedError({ code: 0 }),
    ),
  );

  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout: () => Sink.forEach(processOutboundChunk),
    stderr: () => Sink.drain,
  });

  yield* drainInbound();

  return yield* ZCodeClient.make(stdio, options, terminationError);
});

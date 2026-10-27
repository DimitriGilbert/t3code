import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as ZCodeClient from "@t3tools/effect-zcode-protocol/client";
import * as ZCodeReplay from "@t3tools/effect-zcode-protocol/replay";
import { ZcodeSettings } from "@t3tools/provider-zcode/settings";
import { ZCODE_DEFAULT_INSTANCE_ID, ZCODE_PROVIDER } from "@t3tools/provider-zcode/server";
import {
  ZcodeAppServerSpawnOpenError,
  makeZcodeAdapterV2,
  type ZcodeAppServerClientOpener,
} from "@t3tools/provider-zcode/testing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export class ZcodeReplayTranscriptDecodeError extends Schema.TaggedError<ZcodeReplayTranscriptDecodeError>()(
  "ZcodeReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ZCode app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const ZcodeOrchestratorReplayHarnessError = Schema.Union([
  ZcodeReplayTranscriptDecodeError,
  ZCodeReplay.ZCodeAppServerReplayError,
]);
export type ZcodeOrchestratorReplayHarnessError = typeof ZcodeOrchestratorReplayHarnessError.Type;

const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZcodeSettings)({});

// The adapter generates each v4/command commandId; turnHeader rows echo the
// owning sendText's id back. Recorded rows carry a placeholder the driver
// rewrites to the observed commandId just before the frame is emitted.
const SEND_TEXT_COMMAND_ID_PLACEHOLDER = /^<sendText-commandId(?::(\d+))?>$/;

function substituteSendTextCommandIds(frame: unknown, commandIds: ReadonlyArray<string>): void {
  if (typeof frame === "string") return;
  if (Array.isArray(frame)) {
    for (const entry of frame) substituteSendTextCommandIds(entry, commandIds);
    return;
  }
  if (typeof frame !== "object" || frame === null) return;
  for (const [key, value] of Object.entries(frame)) {
    if (typeof value === "string") {
      const match = SEND_TEXT_COMMAND_ID_PLACEHOLDER.exec(value);
      if (match !== null) {
        const replacement =
          match[1] === undefined ? commandIds.at(-1) : commandIds[Number.parseInt(match[1], 10)];
        if (replacement !== undefined) {
          (frame as Record<string, unknown>)[key] = replacement;
        }
      }
      continue;
    }
    substituteSendTextCommandIds(value, commandIds);
  }
}

const isSendTextFrame = (
  actual: unknown,
): actual is {
  readonly method: "v4/command";
  readonly params: { readonly type: "sendText"; readonly commandId: string };
} =>
  typeof actual === "object" &&
  actual !== null &&
  Reflect.get(actual, "method") === "v4/command" &&
  Reflect.get(Reflect.get(actual, "params") ?? {}, "type") === "sendText" &&
  typeof Reflect.get(Reflect.get(actual, "params") ?? {}, "commandId") === "string";

function layerZcodeProviderAdapterRegistryReplay(
  transcript: ZCodeReplay.ZCodeAppServerReplayTranscript,
  driver: ZCodeReplay.ZCodeAppServerReplayDriver,
) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-zcode-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const openClient: ZcodeAppServerClientOpener = () =>
        Layer.build(ZCodeReplay.layerReplayWithDriver(driver)).pipe(
          Effect.map((context) => Context.get(context, ZCodeClient.ZCodeAppServerClient)),
          Effect.mapError(
            (cause) => new ZcodeAppServerSpawnOpenError({ command: "replay", cause }),
          ),
        );
      const adapter = yield* makeZcodeAdapterV2({
        instanceId: ZCODE_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_ZCODE_SETTINGS,
        // An empty ZCODE_HOME skips the account-overlay push deterministically;
        // machine credentials never leak into recorded scenarios.
        environment: { ZCODE_HOME: path.join(replayDir, "zcode-home") },
        openClient,
      });
      return [adapter];
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer)));
}

const decodeZcodeAppServerReplayTranscript = Schema.decodeUnknownEffect(
  ZCodeReplay.ZCodeAppServerReplayTranscript,
);

export const ZcodeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ZCodeReplay.ZCodeAppServerReplayTranscript,
  ZcodeOrchestratorReplayHarnessError
> = {
  driver: ZCODE_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeZcodeAppServerReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ZcodeReplayTranscriptDecodeError({
            provider: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (
    transcript,
    options: { readonly replayGate?: ProviderReplayGate } = {},
  ) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const replayGate = options.replayGate;
        if (replayGate !== undefined) {
          yield* Effect.addFinalizer(() => Effect.sync(() => replayGate.releaseAll()));
        }
        const sendTextCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript, {
          onOutbound: (actual) =>
            isSendTextFrame(actual)
              ? Ref.update(sendTextCommandIds, (ids) => [...ids, actual.params.commandId])
              : Effect.void,
          beforeEmitInbound: (entry) =>
            Effect.gen(function* () {
              if (replayGate !== undefined) {
                yield* Effect.promise((signal) => replayGate.beforeEmit(entry.label, signal));
              }
              const commandIds = yield* Ref.get(sendTextCommandIds);
              if (commandIds.length > 0) {
                substituteSendTextCommandIds(entry.frame, commandIds);
              }
            }),
        });
        return yield* Layer.build(layerZcodeProviderAdapterRegistryReplay(transcript, driver));
      }),
    ),
};

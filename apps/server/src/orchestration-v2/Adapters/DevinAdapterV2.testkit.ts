import * as NodeServices from "@effect/platform-node/NodeServices";
import { DevinSettings } from "@t3tools/provider-devin/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  DEVIN_DEFAULT_INSTANCE_ID,
  DEVIN_PROVIDER,
  makeDevinAdapterV2,
} from "@t3tools/provider-devin/testing";

const DEFAULT_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({});

function layerDevinProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Same queue the continuation worker drains when the fixture runs it.
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-devin-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeDevinAdapterV2({
        instanceId: DEVIN_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_DEVIN_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        // Same substitution as makeDevinAcpRuntime: the `devin acp` spawn only
        // exists live; replay drives the recorded ACP frames. Client-terminal
        // requests (terminal/create & friends) still execute for real — the
        // recorded commands replay through T3's terminal boundary.
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(replayGate === undefined ? {} : { replayGate }),
        }),
        continuationRequests,
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        ...(replayGate === undefined
          ? {}
          : {
              testHooks: {
                onDeferredFinalizeScheduled: (debounce) =>
                  Effect.sync(() => replayGate.recordFinishArmed(debounce)),
              },
            }),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const DevinOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: DEVIN_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, DEVIN_PROVIDER),
  makeProviderAdapterRegistryLayer: layerDevinProviderAdapterRegistryReplay,
};

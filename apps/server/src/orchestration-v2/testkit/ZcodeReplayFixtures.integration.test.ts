import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { ZcodeOrchestratorReplayHarness } from "../Adapters/ZcodeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Zcode replay fixtures", () => {
  itRunsReplayFixtures("zcode", (input) =>
    runReplayFixture({
      ...input,
      harness: ZcodeOrchestratorReplayHarness,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
    }),
  );
});

import { describe } from "@effect/vitest";

import { DevinOrchestratorReplayHarness } from "../Adapters/DevinAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Devin replay fixtures", () => {
  itRunsReplayFixtures("devin", (input) =>
    runReplayFixture({ ...input, harness: DevinOrchestratorReplayHarness }),
  );
});

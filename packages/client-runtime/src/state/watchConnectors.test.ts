import { describe, expect, it } from "vite-plus/test";
import { WatchConnectorPackId, type WatchConnectorPackManifest } from "@t3tools/contracts";

import {
  diffWatchConnectorManifests,
  watchInstallRequestIsUnfetched,
  watchInstallRequestNeedsReviewAck,
} from "./watchConnectors.ts";

const packId = WatchConnectorPackId.make("pack:acme");

const baseManifest: WatchConnectorPackManifest = {
  id: packId,
  schemaVersion: 1,
  operations: [{ name: "poll" }, { name: "rotate", description: "Rotate credentials" }],
  egressHosts: ["api.acme.test", "cdn.acme.test"],
  secretKeys: ["ACME_TOKEN"],
  transport: "http",
};

describe("diffWatchConnectorManifests", () => {
  it("reports no changes between identical manifests", () => {
    const diff = diffWatchConnectorManifests(baseManifest, { ...baseManifest });
    expect(diff).toEqual({
      schemaVersion: null,
      transport: null,
      egressHosts: { added: [], removed: [] },
      secretKeys: { added: [], removed: [] },
      operations: { added: [], removed: [] },
    });
  });

  it("diffs schema version, transport, and each declared list", () => {
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      schemaVersion: 2,
      transport: "file",
      egressHosts: ["cdn.acme.test", "edge.acme.test"],
      secretKeys: ["ACME_TOKEN", "ACME_REFRESH"],
      operations: [{ name: "poll" }, { name: "snapshot" }],
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.schemaVersion).toEqual({ from: 1, to: 2 });
    expect(diff.transport).toEqual({ from: "http", to: "file" });
    expect(diff.egressHosts).toEqual({
      added: ["edge.acme.test"],
      removed: ["api.acme.test"],
    });
    expect(diff.secretKeys).toEqual({ added: ["ACME_REFRESH"], removed: [] });
    // Operations diff by name — a description edit alone is not a change.
    expect(diff.operations).toEqual({ added: ["snapshot"], removed: ["rotate"] });
  });

  it("ignores ordering-only differences in declared lists", () => {
    const reordered: WatchConnectorPackManifest = {
      ...baseManifest,
      egressHosts: baseManifest.egressHosts.toReversed(),
      secretKeys: baseManifest.secretKeys.toReversed(),
      operations: baseManifest.operations.toReversed(),
    };
    const diff = diffWatchConnectorManifests(baseManifest, reordered);
    expect(diff.egressHosts).toEqual({ added: [], removed: [] });
    expect(diff.secretKeys).toEqual({ added: [], removed: [] });
    expect(diff.operations).toEqual({ added: [], removed: [] });
  });
});

describe("install request review helpers", () => {
  const httpsOrigin = { kind: "httpsUrl" as const, url: "https://packs.acme.test/pack.tgz" };
  const localOrigin = { kind: "localPath" as const, path: "/opt/packs/acme" };

  it("gates https origins behind the review acknowledgement, not local paths", () => {
    expect(watchInstallRequestNeedsReviewAck({ origin: httpsOrigin })).toBe(true);
    expect(watchInstallRequestNeedsReviewAck({ origin: localOrigin })).toBe(false);
    // A server-recorded allowLocalUrl still needs the ack on this client.
    expect(
      watchInstallRequestNeedsReviewAck({ origin: { ...httpsOrigin, allowLocalUrl: true } }),
    ).toBe(true);
  });

  it("flags only localUrl requests still waiting on their deferred fetch", () => {
    expect(watchInstallRequestIsUnfetched({ localUrl: true, manifest: null })).toBe(true);
    expect(watchInstallRequestIsUnfetched({ localUrl: true, manifest: baseManifest })).toBe(false);
    expect(watchInstallRequestIsUnfetched({ localUrl: false, manifest: null })).toBe(false);
    expect(watchInstallRequestIsUnfetched({ localUrl: false, manifest: baseManifest })).toBe(false);
  });
});

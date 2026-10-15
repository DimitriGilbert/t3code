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
  authSchema: { region: { type: "string" } },
  widgets: [
    {
      name: "status",
      file: "widgets/status.tsx",
      bridge: { subscriptions: ["snapshot"], actions: ["refresh"] },
    },
  ],
};

const emptyDiff = {
  schemaVersion: null,
  transport: null,
  egressHosts: { added: [], removed: [] },
  secretKeys: { added: [], removed: [] },
  operations: { added: [], removed: [] },
  operationDescriptions: [],
  widgets: { names: { added: [], removed: [] }, changed: [] },
  authSchemaChanged: false,
  surfaceChanged: false,
};

describe("diffWatchConnectorManifests", () => {
  it("reports no changes between identical manifests", () => {
    const diff = diffWatchConnectorManifests(baseManifest, { ...baseManifest });
    expect(diff).toEqual(emptyDiff);
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
    // The operations list diffs by name; description moves surface separately
    // in `operationDescriptions`.
    expect(diff.operations).toEqual({ added: ["snapshot"], removed: ["rotate"] });
    expect(diff.operationDescriptions).toEqual([]);
  });

  it("ignores ordering-only differences in declared lists", () => {
    const reordered: WatchConnectorPackManifest = {
      ...baseManifest,
      egressHosts: baseManifest.egressHosts.toReversed(),
      secretKeys: baseManifest.secretKeys.toReversed(),
      operations: baseManifest.operations.toReversed(),
      widgets: (baseManifest.widgets ?? []).toReversed(),
    };
    const diff = diffWatchConnectorManifests(baseManifest, reordered);
    expect(diff.egressHosts).toEqual({ added: [], removed: [] });
    expect(diff.secretKeys).toEqual({ added: [], removed: [] });
    expect(diff.operations).toEqual({ added: [], removed: [] });
    expect(diff.widgets).toEqual({ names: { added: [], removed: [] }, changed: [] });
  });

  it("diffs widget names, same-name bridge surfaces, and file moves", () => {
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      schemaVersion: 2,
      widgets: [
        {
          name: "status",
          file: "widgets/status-v2.tsx",
          bridge: { subscriptions: ["snapshot", "events"], actions: [] },
        },
        {
          name: "alerts",
          file: "widgets/alerts.tsx",
          bridge: { subscriptions: [], actions: ["ack"] },
        },
      ],
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.widgets.names).toEqual({ added: ["alerts"], removed: [] });
    expect(diff.widgets.changed).toEqual([
      {
        name: "status",
        file: { from: "widgets/status.tsx", to: "widgets/status-v2.tsx" },
        subscriptions: { added: ["events"], removed: [] },
        actions: { added: [], removed: ["refresh"] },
      },
    ]);
  });

  it("flags removed widgets and leaves untouched ones out of `changed`", () => {
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      widgets: [],
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.widgets.names).toEqual({ added: [], removed: ["status"] });
    expect(diff.widgets.changed).toEqual([]);
  });

  it("marks authSchema changes and operation description moves", () => {
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      authSchema: { region: { type: "string" }, token: { type: "string", secret: true } },
      operations: [
        { name: "poll", description: "Poll the upstream" },
        { name: "rotate", description: "Rotate credentials" },
      ],
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.authSchemaChanged).toBe(true);
    expect(diff.operations).toEqual({ added: [], removed: [] });
    expect(diff.operationDescriptions).toEqual([
      { name: "poll", from: null, to: "Poll the upstream" },
    ]);
  });

  it("leaves authSchemaChanged false for deep-equal schemas", () => {
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      authSchema: { region: { type: "string" } },
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.authSchemaChanged).toBe(false);
    expect(diff).toEqual(emptyDiff);
  });

  it("raises the catch-all surface marker when a non-itemized field moves", () => {
    // `id` is the only residue field today; the flag exists so any future
    // manifest field can never slide through as a bare version bump.
    const next: WatchConnectorPackManifest = {
      ...baseManifest,
      schemaVersion: 2,
      id: WatchConnectorPackId.make("pack:acme-renamed"),
    };
    const diff = diffWatchConnectorManifests(baseManifest, next);
    expect(diff.schemaVersion).toEqual({ from: 1, to: 2 });
    expect(diff.surfaceChanged).toBe(true);
    expect({
      ...diff,
      schemaVersion: null,
      surfaceChanged: true,
    }).toEqual({ ...emptyDiff, surfaceChanged: true });
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

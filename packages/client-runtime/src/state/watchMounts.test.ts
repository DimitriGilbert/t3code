import {
  WatchConnectorPackId,
  WatchWidgetSourceId,
  type WatchPackWidgetSource,
  type WatchWidgetProvenance,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  isMissingPackWidgetKind,
  makeWatchAppMountRegistry,
  WATCH_APP_MOUNT_LIMIT,
  watchAgentSourceId,
} from "./watchMounts.ts";

const packId = Schema.decodeSync(WatchConnectorPackId)("pack-1");
const sourceId = Schema.decodeSync(WatchWidgetSourceId)("source-1");
const otherSourceId = Schema.decodeSync(WatchWidgetSourceId)("source-2");
const packProvenance: WatchWidgetProvenance = `pack:${packId}`;

const packSource = (overrides: Partial<WatchPackWidgetSource> = {}): WatchPackWidgetSource => ({
  packId,
  schemaVersion: 1,
  sourceId,
  name: "Status",
  file: "widgets/status.tsx",
  archivedAt: null,
  ...overrides,
});

describe("watchAgentSourceId", () => {
  it("extracts the source id from agent kinds only", () => {
    expect(watchAgentSourceId(`agent:${sourceId}`)).toBe(sourceId);
    expect(watchAgentSourceId("threads")).toBeUndefined();
    expect(watchAgentSourceId("connector")).toBeUndefined();
    // A malformed agent kind names nothing and is never trusted through.
    expect(watchAgentSourceId("agent:")).toBeUndefined();
    expect(watchAgentSourceId("agent:   ")).toBeUndefined();
  });
});

describe("isMissingPackWidgetKind", () => {
  const kind = `agent:${sourceId}`;

  it("does not apply to non-pack provenance", () => {
    expect(isMissingPackWidgetKind({ kind, provenance: "agentPublished", widgetSources: [] })).toBe(
      false,
    );
    expect(isMissingPackWidgetKind({ kind, provenance: "firstParty", widgetSources: [] })).toBe(
      false,
    );
  });

  it("is missing when the registration is absent or archived", () => {
    expect(isMissingPackWidgetKind({ kind, provenance: packProvenance, widgetSources: [] })).toBe(
      true,
    );
    expect(
      isMissingPackWidgetKind({
        kind,
        provenance: packProvenance,
        widgetSources: [packSource({ archivedAt: "2025-01-01T00:00:00.000Z" })],
      }),
    ).toBe(true);
  });

  it("is present when the pack registered this source id", () => {
    expect(
      isMissingPackWidgetKind({
        kind,
        provenance: packProvenance,
        widgetSources: [packSource()],
      }),
    ).toBe(false);
    // A different source id or pack does not satisfy the registration.
    expect(
      isMissingPackWidgetKind({
        kind,
        provenance: packProvenance,
        widgetSources: [packSource({ sourceId: otherSourceId })],
      }),
    ).toBe(true);
  });

  it("treats a malformed provenance or kind as missing, never present", () => {
    expect(
      isMissingPackWidgetKind({ kind, provenance: "pack:", widgetSources: [packSource()] }),
    ).toBe(true);
    expect(
      isMissingPackWidgetKind({
        kind: "agent:",
        provenance: packProvenance,
        widgetSources: [packSource()],
      }),
    ).toBe(true);
  });
});

describe("makeWatchAppMountRegistry", () => {
  it("mounts lazily on first visibility", () => {
    const registry = makeWatchAppMountRegistry();
    expect(registry.stateOf("a")).toBe("unmounted");
    expect(registry.setVisible("a")).toEqual([{ id: "a", state: "mounted" }]);
    expect(registry.mounted()).toEqual(["a"]);
  });

  it("caps the mounted set and evicts the least recently visible to a placeholder", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      registry.setVisible(id);
    }
    expect(registry.mounted()).toHaveLength(WATCH_APP_MOUNT_LIMIT);

    const changes = registry.setVisible("g");
    expect(registry.mounted()).toContain("g");
    expect(registry.stateOf("a")).toBe("placeholder");
    expect(changes).toEqual([
      { id: "g", state: "mounted" },
      { id: "a", state: "placeholder" },
    ]);
  });

  it("refreshes LRU order on re-visibility so the stalest seat evicts", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f"]) registry.setVisible(id);
    // `a` scrolls back through the viewport — it is no longer the LRU.
    expect(registry.setVisible("a")).toEqual([]);
    const changes = registry.setVisible("g");
    expect(registry.stateOf("b")).toBe("placeholder");
    expect(registry.stateOf("a")).toBe("mounted");
    expect(changes).toEqual([
      { id: "g", state: "mounted" },
      { id: "b", state: "placeholder" },
    ]);
  });

  it("unmounts offscreen widgets and promotes the freshest waiting placeholder", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) registry.setVisible(id);
    expect(registry.stateOf("a")).toBe("placeholder");

    const changes = registry.setHidden("f");
    expect(changes).toEqual([
      { id: "f", state: "unmounted" },
      { id: "a", state: "mounted" },
    ]);
    expect(registry.stateOf("a")).toBe("mounted");
    expect(registry.stateOf("f")).toBe("unmounted");
  });

  it("unmounts a hidden placeholder without promoting anything", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) registry.setVisible(id);
    expect(registry.setHidden("a")).toEqual([{ id: "a", state: "unmounted" }]);
    expect(registry.mounted()).toHaveLength(WATCH_APP_MOUNT_LIMIT);
  });

  it("mounts a tapped placeholder immediately, evicting the LRU", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) registry.setVisible(id);
    const changes = registry.requestMount("a");
    expect(registry.stateOf("a")).toBe("mounted");
    // `a` takes the freshest seat; the previous most-recently-visible `g` stays
    // mounted and the new LRU `b` — not `g` — drops to the placeholder.
    expect(changes).toEqual([
      { id: "a", state: "mounted" },
      { id: "b", state: "placeholder" },
    ]);
  });

  it("refuses a tap-mount for an id the registry is not tracking", () => {
    const registry = makeWatchAppMountRegistry();
    // A tap can't seat an invisible widget — an untracked id is a no-op.
    expect(registry.requestMount("ghost")).toEqual([]);
    expect(registry.stateOf("ghost")).toBe("unmounted");
    expect(registry.mounted()).toEqual([]);
  });

  it("does not mount a placeholder that scrolled out before the tap landed", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) registry.setVisible(id);
    // `a` was evicted to the placeholder, then scrolled offscreen — the
    // registry dropped it before a stale tap could flush.
    registry.setHidden("a");
    expect(registry.requestMount("a")).toEqual([]);
    expect(registry.stateOf("a")).toBe("unmounted");
    // Its seat was not stolen: the six still-visible widgets stay mounted.
    expect(registry.mounted()).toHaveLength(WATCH_APP_MOUNT_LIMIT);
  });

  it("seats an auto-promoted placeholder at the freshest position", () => {
    const registry = makeWatchAppMountRegistry();
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) registry.setVisible(id);
    registry.setHidden("f");
    expect(registry.stateOf("a")).toBe("mounted");
    // `a` is still visible, so promotion takes the freshest seat — the next
    // overflow evicts the real LRU rather than bouncing `a` back out.
    expect(registry.mounted()[0]).toBe("a");
    expect(registry.setVisible("h")).toEqual([
      { id: "h", state: "mounted" },
      { id: "b", state: "placeholder" },
    ]);
    expect(registry.stateOf("a")).toBe("mounted");
    expect(registry.stateOf("b")).toBe("placeholder");
  });

  it("stops tracking a removed widget", () => {
    const registry = makeWatchAppMountRegistry();
    registry.setVisible("a");
    expect(registry.remove("a")).toEqual([{ id: "a", state: "unmounted" }]);
    expect(registry.stateOf("a")).toBe("unmounted");
    expect(registry.remove("a")).toEqual([]);
  });
});

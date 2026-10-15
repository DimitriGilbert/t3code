import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { emitWatchUiAction, onWatchUiAction, type WatchUiAction } from "./watchUiBus";

// The bus is module-level, so the suite keeps it clean by construction:
// every listener is unregistered, and registering a listener always drains
// the backlog — leftovers can never leak into the next case.
const collect = () => {
  const received: WatchUiAction[] = [];
  const off = onWatchUiAction((action) => received.push(action));
  return { received, off };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("watchUiBus", () => {
  it("delivers immediately to a registered listener", () => {
    const first = collect();
    emitWatchUiAction("toggle-edit");
    first.off();
    expect(first.received).toEqual(["toggle-edit"]);

    // Clean the queue the emit below creates.
    emitWatchUiAction("new-page");
    const second = collect();
    second.off();
    expect(second.received).toEqual(["new-page"]);
  });

  it("replays an action queued while no screen was mounted (open-gallery after navigate)", () => {
    emitWatchUiAction("open-gallery");
    const { received, off } = collect();
    off();
    expect(received).toEqual(["open-gallery"]);
  });

  it("expires a queued action instead of detonating on an unrelated mount", () => {
    vi.useFakeTimers();
    emitWatchUiAction("toggle-edit");
    // Minutes later the user opens /watch for another reason — the stale
    // keypress must not fire.
    vi.advanceTimersByTime(60_000);
    const { received, off } = collect();
    off();
    expect(received).toEqual([]);
  });

  it("delivers a queued action that is still inside its TTL", () => {
    vi.useFakeTimers();
    emitWatchUiAction("add-widget");
    vi.advanceTimersByTime(1_000);
    const { received, off } = collect();
    off();
    expect(received).toEqual(["add-widget"]);
  });

  it("flushes once — a later mount sees an empty queue", () => {
    emitWatchUiAction("switch-page");
    const first = collect();
    first.off();
    expect(first.received).toEqual(["switch-page"]);

    const second = collect();
    second.off();
    expect(second.received).toEqual([]);
  });

  it("bounds the backlog — a burst of off-route emits keeps only the newest", () => {
    emitWatchUiAction("new-page");
    for (let index = 0; index < 20; index += 1) emitWatchUiAction("toggle-edit");
    const { received, off } = collect();
    off();
    // The oldest emit ("new-page") was pushed out; the cap delivers the
    // most recent 8.
    expect(received).toHaveLength(8);
    expect(received.every((action) => action === "toggle-edit")).toBe(true);
  });

  it("stops delivering after the listener unregisters", () => {
    const { received, off } = collect();
    off();
    emitWatchUiAction("toggle-edit"); // queues — nobody listening
    expect(received).toEqual([]);
    // Drain so the queued action can't leak into the next test.
    const drain = collect();
    drain.off();
    expect(drain.received).toEqual(["toggle-edit"]);
  });
});

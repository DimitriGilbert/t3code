import { EnvironmentId, WatchPageId, WatchWidgetId, type WatchWidget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The artifact body subscribes through environment atoms; with
// mountState="unmounted" it never renders, so the state module is mocked away.
vi.mock("~/state/watch", () => ({
  watchEnvironment: {
    widgetSourceLive: vi.fn(),
    getWidgetSource: {},
  },
}));

import { WatchAppWidget } from "./WatchAppWidget";

const environmentId = Schema.decodeSync(EnvironmentId)("env-1");
const widget: WatchWidget = {
  id: WatchWidgetId.make("watch-widget:w1"),
  pageId: WatchPageId.make("watch-page:p1"),
  kind: "agent:watch-widget-source:w1",
  config: {},
  placement: { x: 0, y: 0, w: 2, h: 2 },
  revision: 0,
  mobileOrder: 0,
  mobileHidden: false,
  provenance: "agentPublished",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

type ObserverCallback = (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void;

const observers: Array<{
  callback: ObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      constructor(callback: ObserverCallback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
      }
    },
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const element = (onVisibilityChange: (visible: boolean) => void) => (
  <WatchAppWidget
    environmentId={environmentId}
    widget={widget}
    packWidgetSources={[]}
    mountState="unmounted"
    onVisibilityChange={onVisibilityChange}
    onRequestLoad={() => undefined}
    onSourceRecord={() => undefined}
  />
);

describe("WatchAppWidget visibility reporting", () => {
  // The caller (WatchWidgetBody) builds fresh closures every render. A
  // callback-keyed effect would teardown-and-report-hidden on each render,
  // oscillating the mount seat forever.
  it("does not tear down the observer when re-rendered with fresh callbacks", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      renderer = create(element(first), { createNodeMock: () => ({}) });
    });
    expect(observers).toHaveLength(1);

    act(() => {
      renderer!.update(element(second));
    });

    // Same observer, no hidden report — the widget keeps its mount seat.
    expect(observers).toHaveLength(1);
    expect(observers[0]!.disconnect).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    // New reports still land on the latest callback.
    act(() => observers[0]!.callback([{ isIntersecting: true }]));
    expect(second).toHaveBeenCalledWith(true);
    expect(first).not.toHaveBeenCalled();
  });

  it("reports hidden once on real unmount", async () => {
    const onVisibilityChange = vi.fn();
    act(() => {
      renderer = create(element(onVisibilityChange), { createNodeMock: () => ({}) });
    });
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});

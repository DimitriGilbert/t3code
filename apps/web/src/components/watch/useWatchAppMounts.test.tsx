import { WatchWidgetId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useWatchAppMounts } from "./useWatchAppMounts";
import { act } from "../../../test/act";

/**
 * The hook is the wiring between `WatchAppWidget`'s IntersectionObserver
 * reports and the shared mount registry — these tests drive it through its
 * public surface (`reportVisibility`/`requestMount`) the way the observer
 * does, and assert what each widget then renders via `stateOf`.
 */

interface TestWidget {
  readonly id: WatchWidgetId;
  readonly kind: string;
}

const agentWidget = (name: string): TestWidget => ({
  id: WatchWidgetId.make(`watch-widget:${name}`),
  kind: `agent:watch-widget-source:${name}`,
});
const firstPartyWidget = (name: string): TestWidget => ({
  id: WatchWidgetId.make(`watch-widget:${name}`),
  kind: "threads.activeWork",
});

async function mountBoard(widgets: ReadonlyArray<TestWidget>): Promise<{
  renderer: ReactTestRenderer;
  controls: () => ReturnType<typeof useWatchAppMounts>;
  states: () => Readonly<Record<string, string>>;
  update: (next: ReadonlyArray<TestWidget>) => Promise<void>;
}> {
  let renderer!: ReactTestRenderer;
  let controls!: ReturnType<typeof useWatchAppMounts>;
  let latest: Readonly<Record<string, string>> = {};

  function Probe(props: { widgets: ReadonlyArray<TestWidget> }) {
    const mounts = useWatchAppMounts({ registryKey: "env-1:page-1", widgets: props.widgets });
    useEffect(() => {
      controls = mounts;
      latest = Object.fromEntries(props.widgets.map((w) => [w.id, mounts.stateOf(w.id)]));
    });
    return null;
  }

  await act(() => {
    renderer = create(<Probe widgets={widgets} />);
  });
  return {
    renderer,
    controls: () => controls,
    states: () => latest,
    update: (next) =>
      act(() => {
        renderer.update(<Probe widgets={next} />);
      }),
  };
}

describe("useWatchAppMounts", () => {
  let mounted: Awaited<ReturnType<typeof mountBoard>> | undefined;
  afterEach(async () => {
    await act(() => mounted?.renderer.unmount());
    mounted = undefined;
  });

  it("mounts visible widgets, caps at six, and holds extras as placeholders", async () => {
    const widgets = Array.from({ length: 8 }, (_, i) => agentWidget(`w${i}`));
    mounted = await mountBoard(widgets);
    const controls = mounted.controls();
    for (const widget of widgets) {
      await act(() => controls.reportVisibility(widget.id, true));
    }
    const states = mounted.states();
    expect(Object.values(states).filter((s) => s === "mounted")).toHaveLength(6);
    expect(Object.values(states).filter((s) => s === "placeholder")).toHaveLength(2);
    // The last two visible are the freshest — eviction takes the oldest.
    expect(states[widgets[6]!.id]).toBe("mounted");
    expect(states[widgets[7]!.id]).toBe("mounted");
  });

  it("hiding a mounted widget promotes a standby placeholder", async () => {
    const widgets = Array.from({ length: 7 }, (_, i) => agentWidget(`w${i}`));
    mounted = await mountBoard(widgets);
    const controls = mounted.controls();
    for (const widget of widgets) {
      await act(async () => controls.reportVisibility(widget.id, true));
    }
    // w0 was evicted first — it's the standby that promotes next.
    expect(mounted.states()[widgets[0]!.id]).toBe("placeholder");
    await act(() => controls.reportVisibility(widgets[6]!.id, false));
    const states = mounted.states();
    expect(states[widgets[6]!.id]).toBe("unmounted");
    expect(states[widgets[0]!.id]).toBe("mounted");
  });

  it("requestMount seats a placeholder, evicting the least recent mounted", async () => {
    const widgets = Array.from({ length: 7 }, (_, i) => agentWidget(`w${i}`));
    mounted = await mountBoard(widgets);
    const controls = mounted.controls();
    for (const widget of widgets) {
      await act(async () => controls.reportVisibility(widget.id, true));
    }
    await act(() => controls.requestMount(widgets[0]!.id));
    const states = mounted.states();
    expect(states[widgets[0]!.id]).toBe("mounted");
    // w1 is now the oldest mounted — it takes the placeholder seat.
    expect(states[widgets[1]!.id]).toBe("placeholder");
  });

  it("frees a seat and ignores non-agent kinds when widgets leave the page", async () => {
    const mixed = [
      ...Array.from({ length: 7 }, (_, i) => agentWidget(`w${i}`)),
      firstPartyWidget("fp"),
    ];
    mounted = await mountBoard(mixed);
    const controls = mounted.controls();
    for (const widget of mixed) {
      await act(() => controls.reportVisibility(widget.id, true));
    }
    expect(mounted.states()[mixed[0]!.id]).toBe("placeholder");
    // Removing a mounted agent widget promotes the standby; the first-party
    // widget is never tracked by the registry at all.
    await mounted.update(mixed.filter((w) => w.id !== mixed[6]!.id && w.id !== mixed[7]!.id));
    const states = mounted.states();
    expect(states[mixed[0]!.id]).toBe("mounted");
  });
});

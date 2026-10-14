import {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchWidgetId,
  type WatchWidgetBridgeManifest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The default feed subscribes through environment atoms; these tests inject
// their own feed renderer, so the state module is mocked away entirely.
vi.mock("~/state/watch", () => ({
  watchEnvironment: {
    connectorStream: vi.fn(),
  },
}));

const harness = vi.hoisted(() => ({
  theme: { appearance: "dark" as const, variables: { "--background": "#000000" } },
}));

// The frame contributes the live theme to host context; pinned here so the
// palette modules (localStorage, matchMedia) stay out of the bridge tests.
vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => harness.theme,
}));

import { WatchAppFrame, type WatchAppFeedProps } from "./WatchAppFrame";

const environmentId = Schema.decodeSync(EnvironmentId)("env-1");
const widgetId = Schema.decodeSync(WatchWidgetId)("widget-1");
const instanceId = Schema.decodeSync(WatchConnectorInstanceId)("instance-1");
const manifest: WatchWidgetBridgeManifest = {
  subscriptions: ["status"],
  actions: ["restart"],
};
const BUNDLE = "globalThis.__t3WidgetRan=true;";

let renderer: ReactTestRenderer | undefined;
let contentWindow: { postMessage: ReturnType<typeof vi.fn> };
let messageListener: ((event: { source: unknown; data: unknown }) => void) | undefined;

const fakeWindow = {
  addEventListener: vi.fn(
    (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
      messageListener = listener;
    },
  ),
  removeEventListener: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  contentWindow = { postMessage: vi.fn() };
  messageListener = undefined;
  fakeWindow.addEventListener.mockClear();
  fakeWindow.removeEventListener.mockClear();
  vi.stubGlobal("window", fakeWindow);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(overrides: Partial<Parameters<typeof WatchAppFrame>[0]> = {}) {
  const onViolation = vi.fn();
  // renderFeed re-runs each render; keep the latest props per feed name.
  const feeds = new Map<string, WatchAppFeedProps>();
  await act(async () => {
    renderer = create(
      <WatchAppFrame
        environmentId={environmentId}
        widgetId={widgetId}
        manifest={manifest}
        bundle={BUNDLE}
        scriptHash="abc123hash=="
        connectorInstanceId={instanceId}
        onViolation={onViolation}
        renderFeed={(feed) => {
          feeds.set(feed.feed.name, feed);
          return null;
        }}
        {...overrides}
      />,
      {
        // The ref is the iframe element; the bridge reaches its contentWindow.
        createNodeMock: (element) => (element.type === "iframe" ? { contentWindow } : {}),
      },
    );
  });
  return { onViolation, feeds };
}

const postedMessages = () => contentWindow.postMessage.mock.calls.map((call) => call[0]);

// Mount pushes the initial host context as a notification; assertions about
// request/response traffic filter it out rather than restating it.
const postedReplies = () =>
  postedMessages().filter((message) => !("method" in (message as Record<string, unknown>)));

const postToHost = (data: unknown, source: unknown = contentWindow) =>
  act(async () => {
    messageListener?.({ source, data });
  });

describe("WatchAppFrame sandbox contract", () => {
  it("mounts a srcdoc iframe with allow-scripts only — never same-origin", async () => {
    await mount();
    const iframe = renderer!.root.findByType("iframe").props as {
      readonly sandbox: string;
      readonly srcDoc: string;
      readonly referrerPolicy: string;
      readonly src?: string;
    };
    expect(iframe.sandbox).toBe("allow-scripts");
    expect(iframe.sandbox).not.toContain("allow-same-origin");
    expect(iframe.sandbox).not.toContain("allow-forms");
    expect(iframe.referrerPolicy).toBe("no-referrer");

    const srcdoc = iframe.srcDoc;
    // Zero-network CSP with both script hashes, then prelude, then the bundle.
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("'sha256-abc123hash=='");
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("globalThis.T3"));
    expect(srcdoc.indexOf("globalThis.T3")).toBeLessThan(srcdoc.indexOf(BUNDLE));
    // No network URL: the document is inline, not fetched.
    expect(iframe.src).toBeUndefined();
  });
});

describe("WatchAppFrame bridge wiring", () => {
  it("answers a declared subscribe and mounts a feed bound to the row's instance", async () => {
    const { onViolation, feeds } = await mount();
    await postToHost({
      jsonrpc: "2.0",
      id: 1,
      method: "t3.watch/subscribe",
      params: { name: "status" },
    });
    expect(onViolation).not.toHaveBeenCalled();
    expect(postedReplies()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    const feed = feeds.get("status");
    expect(feed?.feed).toEqual({ name: "status", instanceId });
    expect(feed?.environmentId).toBe(environmentId);
    expect(feed?.widgetId).toBe(widgetId);
  });

  it("drops an undeclared call, posts an error reply, and surfaces the violation", async () => {
    const { onViolation, feeds } = await mount();
    await postToHost({
      jsonrpc: "2.0",
      id: 1,
      method: "t3.watch/subscribe",
      params: { name: "secrets" },
    });
    expect(feeds.size).toBe(0);
    expect(onViolation).toHaveBeenCalledWith(
      expect.objectContaining({ code: "undeclaredSubscription", name: "secrets" }),
    );
    const replies = postedReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ jsonrpc: "2.0", id: 1, error: expect.anything() });
  });

  it("drops a subscribe naming a foreign connector instance", async () => {
    const { onViolation, feeds } = await mount();
    await postToHost({
      jsonrpc: "2.0",
      id: 1,
      method: "t3.watch/subscribe",
      params: { name: "status", instanceId: "instance-other" },
    });
    expect(feeds.size).toBe(0);
    expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ code: "foreignInstance" }));
  });

  it("ignores messages that did not come from this frame's window", async () => {
    await mount();
    await postToHost({ jsonrpc: "2.0", id: 1, method: "t3.watch/context" }, { other: true });
    expect(postedReplies()).toEqual([]);
  });

  it("lets an injected feed deliver stream items to the document", async () => {
    const { feeds } = await mount();
    await postToHost({
      jsonrpc: "2.0",
      id: 1,
      method: "t3.watch/subscribe",
      params: { name: "status" },
    });
    act(() => {
      feeds.get("status")?.host.deliver("status", { up: true });
    });
    expect(postedMessages().at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "t3.watch/data",
      params: { name: "status", item: { up: true } },
    });
  });

  it("answers t3.watch/context with the live theme, merged under caller context", async () => {
    await mount({ hostContext: () => ({ density: "compact" }) });
    await postToHost({ jsonrpc: "2.0", id: 1, method: "t3.watch/context" });
    expect(postedMessages()).toEqual([
      {
        jsonrpc: "2.0",
        method: "t3.watch/context",
        params: {
          theme: "dark",
          styles: { variables: { "--background": "#000000" } },
          density: "compact",
        },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          theme: "dark",
          styles: { variables: { "--background": "#000000" } },
          density: "compact",
        },
      },
    ]);
  });
});

describe("WatchAppFrame navigation containment", () => {
  it("unmounts the iframe and stops the widget when the document navigates away", async () => {
    const { onViolation, feeds } = await mount();
    await postToHost({
      jsonrpc: "2.0",
      id: 1,
      method: "t3.watch/subscribe",
      params: { name: "status" },
    });
    expect(feeds.get("status")).toBeDefined();

    // The first load is the generated document; a second load on the same
    // document means the frame navigated itself.
    const fireLoad = () =>
      act(async () => {
        (renderer!.root.findByType("iframe").props as { onLoad: () => void }).onLoad();
      });
    await fireLoad();
    expect(renderer!.root.findAllByType("iframe")).toHaveLength(1);
    await fireLoad();

    expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ code: "navigatedAway" }));
    // The hostile document is unmounted, not just disconnected, and the
    // stopped message renders in its place.
    expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
    expect(
      renderer!.root.findAllByType("p").some((p) => p.children.join("").includes("stopped")),
    ).toBe(true);
    // Disposal closed the feed; the dead host can no longer post to the page.
    act(() => {
      feeds.get("status")?.host.deliver("status", { up: true });
    });
    expect(
      postedMessages().every((m) => (m as { method?: string }).method !== "t3.watch/data"),
    ).toBe(true);
  });
});

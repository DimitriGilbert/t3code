// @vitest-environment jsdom
import {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchWidgetId,
  type WatchWidgetBridgeManifest,
} from "@t3tools/contracts";
import type { WatchAppHost } from "@t3tools/client-runtime/watch-app-bridge";
import * as Schema from "effect/Schema";
import { act, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Native modules are mocked to props-capturing host stubs; the WebView mock
// records every render's props so the sandbox contract is asserted directly.
const harness = vi.hoisted(() => ({
  platform: { OS: "android" },
  webViewProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Platform: harness.platform,
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));

vi.mock("react-native-webview", () => ({
  WebView: (props: Record<string, unknown>) => {
    harness.webViewProps.push(props);
    return null;
  },
}));

vi.mock("../../state/watch", () => ({
  watchEnvironment: {
    connectorStream: vi.fn(),
  },
}));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeId: "t3-dark",
    themeAppearance: "dark",
    themeVariables: {},
    systemColorsActive: false,
  }),
}));

vi.mock("../../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ appearance: "dark", variables: { "--background": "#000000" } }),
}));

import { WatchAppWebView } from "./WatchAppWebView";

const environmentId = Schema.decodeSync(EnvironmentId)("env-1");
const widgetId = Schema.decodeSync(WatchWidgetId)("widget-1");
const instanceId = Schema.decodeSync(WatchConnectorInstanceId)("instance-1");
const manifest: WatchWidgetBridgeManifest = {
  subscriptions: ["status"],
  actions: [],
};

let container: HTMLDivElement;
let root: Root | null = null;

function mount(overrides: Partial<ComponentProps<typeof WatchAppWebView>> = {}) {
  act(() => {
    root = createRoot(container);
    root.render(
      <WatchAppWebView
        environmentId={environmentId}
        widgetId={widgetId}
        manifest={manifest}
        bundle="globalThis.__t3WidgetRan=true;"
        scriptHash="abc123hash=="
        connectorInstanceId={instanceId}
        renderFeed={() => null}
        {...overrides}
      />,
    );
  });
}

const webViewProps = () => {
  const props = harness.webViewProps.at(-1);
  if (props === undefined) throw new Error("The WebView never rendered");
  return props;
};

const shouldStartLoad = (url: string) =>
  (webViewProps().onShouldStartLoadWithRequest as (request: { url: string }) => boolean)({ url });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  harness.webViewProps.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("WatchAppWebView load gates", () => {
  it("denies every request except the document's own about:blank load on Android", () => {
    harness.platform.OS = "android";
    mount();
    // The wildcard whitelist is deliberate: every request reaches this JS
    // callback, so a rejected URL is never handed to the OS browser.
    expect(webViewProps().originWhitelist).toEqual(["*"]);
    expect(shouldStartLoad("about:blank")).toBe(true);
    expect(shouldStartLoad("https://evil.example/?data=secret")).toBe(false);
    expect(shouldStartLoad("file:///etc/passwd")).toBe(false);
    expect(webViewProps().setSupportMultipleWindows).toBe(false);
    expect(webViewProps().domStorageEnabled).toBe(false);
    expect(webViewProps().allowFileAccess).toBe(false);
    expect(webViewProps().allowUniversalAccessFromFileURLs).toBe(false);
  });

  it("applies the identical deny contract on iOS", () => {
    harness.platform.OS = "ios";
    mount();
    expect(webViewProps().originWhitelist).toEqual(["*"]);
    expect(shouldStartLoad("about:blank")).toBe(true);
    expect(shouldStartLoad("https://evil.example/?data=secret")).toBe(false);
  });
});

/** Records feed mounts/unmounts so a disposed host's closeName path is observed end to end. */
function FeedProbe(props: { name: string; opened: Array<string>; closed: Array<string> }) {
  const { name, opened, closed } = props;
  useEffect(() => {
    opened.push(name);
    return () => {
      closed.push(name);
    };
  }, [name, opened, closed]);
  return null;
}

describe("WatchAppWebView session teardown", () => {
  const postToHost = (message: unknown) => {
    (webViewProps().onMessage as (event: { nativeEvent: { data: string } }) => void)({
      nativeEvent: { data: JSON.stringify(message) },
    });
  };

  // Drives the bridge subscribe request the prelude would post; the open
  // handshake resolves on a microtask, so this awaits act to settle it.
  const openStatusFeed = async () => {
    await act(async () => {
      postToHost({
        jsonrpc: "2.0",
        id: 1,
        method: "t3.watch/subscribe",
        params: { name: "status" },
      });
    });
  };

  it("keeps the session alive on the first load and stops it on a second", async () => {
    const onViolation = vi.fn();
    const opened: Array<string> = [];
    const closed: Array<string> = [];
    mount({
      onViolation,
      renderFeed: ({ feed }) => <FeedProbe name={feed.name} opened={opened} closed={closed} />,
    });
    await openStatusFeed();
    expect(opened).toEqual(["status"]);

    act(() => {
      (webViewProps().onLoadStart as () => void)();
    });
    // The first load is the generated document itself — the session lives.
    expect(closed).toEqual([]);
    expect(onViolation).not.toHaveBeenCalled();

    act(() => {
      (webViewProps().onLoadStart as () => void)();
    });
    // A second load means a page T3 never generated (e.g. location.reload()).
    expect(closed).toEqual(["status"]);
    expect(container.textContent).toContain("The widget left its page and was stopped");
    expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ code: "navigatedAway" }));
  });

  it("denies even an about:blank request once the first load has started", () => {
    mount();
    act(() => {
      (webViewProps().onLoadStart as () => void)();
    });
    expect(shouldStartLoad("about:blank")).toBe(false);
    expect(shouldStartLoad("https://evil.example/")).toBe(false);
  });

  it("closes subscriptions and reports navigatedAway when the page navigates away", async () => {
    const onViolation = vi.fn();
    const opened: Array<string> = [];
    const closed: Array<string> = [];
    mount({
      onViolation,
      renderFeed: ({ feed }) => <FeedProbe name={feed.name} opened={opened} closed={closed} />,
    });
    await openStatusFeed();
    expect(opened).toEqual(["status"]);

    act(() => {
      (webViewProps().onNavigationStateChange as (navState: { url: string }) => void)({
        url: "https://evil.example/",
      });
    });
    expect(closed).toEqual(["status"]);
    expect(container.textContent).toContain("The widget left its page and was stopped");
    expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ code: "navigatedAway" }));
  });

  it.each([
    "onContentProcessDidTerminate",
    "onRenderProcessGone",
    "onError",
    "onHttpError",
  ] as const)("disposes the host and closes subscriptions when %s fires", async (handler) => {
    const opened: Array<string> = [];
    const closed: Array<string> = [];
    let capturedHost: WatchAppHost | null = null;
    mount({
      renderFeed: (feedProps) => {
        capturedHost = feedProps.host;
        return <FeedProbe name={feedProps.feed.name} opened={opened} closed={closed} />;
      },
    });
    await openStatusFeed();
    const dispose = vi.spyOn(capturedHost!, "dispose");

    act(() => {
      (webViewProps()[handler] as () => void)();
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(closed).toEqual(["status"]);
    expect(container.textContent).toContain("Unable to load the widget");
  });
});

describe("WatchAppWebView navigation containment", () => {
  it("stops the widget and unmounts the WebView when the page navigates away", () => {
    mount();
    act(() => {
      (webViewProps().onNavigationStateChange as (navState: { url: string }) => void)({
        url: "https://evil.example/",
      });
    });
    expect(container.textContent).toContain("The widget left its page and was stopped");
    // The WebView branch is gone — no further props are rendered into it.
    const count = harness.webViewProps.length;
    act(() =>
      root!.render(
        <WatchAppWebView
          environmentId={environmentId}
          widgetId={widgetId}
          manifest={manifest}
          bundle="globalThis.__t3WidgetRan=true;"
          scriptHash="abc123hash=="
          connectorInstanceId={instanceId}
          renderFeed={() => null}
        />,
      ),
    );
    expect(harness.webViewProps.length).toBe(count);
  });
});

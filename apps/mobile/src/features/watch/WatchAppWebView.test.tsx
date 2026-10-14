// @vitest-environment jsdom
import {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchWidgetId,
  type WatchWidgetBridgeManifest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
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

function mount() {
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

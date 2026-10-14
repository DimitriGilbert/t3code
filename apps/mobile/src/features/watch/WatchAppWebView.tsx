import type {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchWidgetBridgeManifest,
  WatchWidgetId,
  WatchWidgetRefreshPolicy,
} from "@t3tools/contracts";
import {
  buildWatchAppDocument,
  makeWatchAppHost,
  WatchAppHostRefusal,
  type WatchAppBridgeViolation,
  type WatchAppHost,
} from "@t3tools/client-runtime/watch-app-bridge";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Predicate from "effect/Predicate";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { watchEnvironment } from "../../state/watch";

/**
 * The mobile twin of `WatchAppFrame`: the same generated document (prelude,
 * CSP meta, bundle — byte-identical because `buildWatchAppDocument` is shared)
 * in a react-native WebView instead of a srcdoc iframe. The prelude detects
 * `ReactNativeWebView` and posts JSON-RPC over it, so the bridge needs no
 * relay page. Web-enforcement parity: `setSupportMultipleWindows={false}`
 * stands in for the frame sandbox's popup ban, `domStorageEnabled={false}`
 * for its opaque origin, and the load gates + navigation watcher stand in for
 * the sandbox's navigation ban — a widget that leaves its page is stopped.
 */

export interface WatchAppFeedSubscription {
  readonly name: string;
  readonly instanceId: WatchConnectorInstanceId;
}

export interface WatchAppFeedProps {
  readonly feed: WatchAppFeedSubscription;
  readonly host: WatchAppHost;
  readonly environmentId: EnvironmentId;
  readonly widgetId: WatchWidgetId;
  readonly refreshPolicy?: WatchWidgetRefreshPolicy;
}

/** Feeds a bridge-opened subscription from the bound connector's snapshot stream. */
function WatchAppConnectorFeed(props: WatchAppFeedProps) {
  const result = useAtomValue(
    watchEnvironment.connectorStream({
      environmentId: props.environmentId,
      input: {
        instanceId: props.feed.instanceId,
        widgetId: props.widgetId,
        ...(props.refreshPolicy === undefined ? {} : { refreshPolicy: props.refreshPolicy }),
      },
    }),
  );
  useEffect(() => {
    if (result._tag === "Success") {
      props.host.deliver(props.feed.name, result.value);
      return;
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      props.host.deliverError(
        props.feed.name,
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "The connector stream failed.",
      );
    }
    // The host identity is stable for the document's lifetime.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [result]);
  return null;
}

export function WatchAppWebView(props: {
  readonly environmentId: EnvironmentId;
  readonly widgetId: WatchWidgetId;
  /** The manifest the artifact was published with; every call is validated against it. */
  readonly manifest: WatchWidgetBridgeManifest;
  /** The emitted single-file bundle (injected verbatim, hash-authorized). */
  readonly bundle: string;
  /** The record's base64 SHA-256 of the bundle — the CSP hash-source. */
  readonly scriptHash: string;
  /** The connector instance the widget row binds; the only one its subscriptions may reach. */
  readonly connectorInstanceId?: WatchConnectorInstanceId;
  readonly refreshPolicy?: WatchWidgetRefreshPolicy;
  /** Declared actions the host implements; undeclared names never reach it. */
  readonly actions?: Readonly<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;
  /** Manifest breaches and foreign-instance calls surface here as widget errors. */
  readonly onViolation?: (violation: WatchAppBridgeViolation) => void;
  readonly hostContext?: () => Record<string, unknown>;
  readonly title?: string;
  readonly renderFeed?: (props: WatchAppFeedProps) => ReactNode;
}) {
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<WatchAppHost | null>(null);
  const [host, setHost] = useState<WatchAppHost | null>(null);
  const [subscriptions, setSubscriptions] = useState<ReadonlyArray<WatchAppFeedSubscription>>([]);
  const [loaded, setLoaded] = useState(false);
  const [crashed, setCrashed] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);

  // One generated document per artifact — the same bytes web puts in srcdoc.
  const html = useMemo(
    () => buildWatchAppDocument({ bundle: props.bundle, scriptHash: props.scriptHash }),
    [props.bundle, props.scriptHash],
  );

  const live = { props };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  // A new document resets the view's lifecycle flags — the sanctioned
  // "adjust state on prop change" pattern, no cascading effect needed.
  const [sessionDocument, setSessionDocument] = useState(html);
  if (sessionDocument !== html) {
    setSessionDocument(html);
    setCrashed(false);
    setNavigatedAway(false);
    setLoaded(false);
  }

  useEffect(() => {
    const next = makeWatchAppHost({
      manifest: latest.current.props.manifest,
      connectorInstanceId: () => latest.current.props.connectorInstanceId,
      // The document's receive hook lives in the prelude; gate on typeof so a
      // reply queued before the bundle ran is dropped rather than throwing.
      post: (message) => {
        const script = `window.__t3WatchAppReceive&&window.__t3WatchAppReceive(${JSON.stringify(message)});true;`;
        webView.current?.injectJavaScript(script);
      },
      openSubscription: async ({ name, instanceId }) => {
        if (instanceId === undefined) {
          throw new WatchAppHostRefusal("This widget has no connector instance bound.");
        }
        const feed = { name, instanceId };
        setSubscriptions((current) =>
          current.some((entry) => entry.name === name) ? current : [...current, feed],
        );
      },
      closeSubscription: ({ name }) => {
        setSubscriptions((current) => current.filter((entry) => entry.name !== name));
      },
      invokeAction: async ({ name, arguments: args }) => {
        const handler = latest.current.props.actions?.[name];
        if (handler === undefined) {
          throw new WatchAppHostRefusal("This action is not available here.");
        }
        return handler(args);
      },
      onViolation: (violation) => latest.current.props.onViolation?.(violation),
      hostContext: () => latest.current.props.hostContext?.() ?? {},
    });
    hostRef.current = next;
    setHost(next);
    return () => {
      next.dispose();
      hostRef.current = null;
      setHost(null);
      setSubscriptions([]);
    };
    // A new document is a new widget session and needs a new host.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [html]);

  // Anything but the generated page's own `about:blank` means the widget left
  // its page; the bridge is dead either way, so stop it and say so.
  const stopIfNavigated = (url: string) => {
    if (navigatedAway || url === "about:blank" || url === "") return;
    hostRef.current?.dispose();
    setNavigatedAway(true);
  };

  const renderFeed =
    props.renderFeed ?? ((feed: WatchAppFeedProps) => <WatchAppConnectorFeed {...feed} />);

  return (
    <View style={{ flex: 1 }}>
      {navigatedAway || crashed ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">
            {navigatedAway
              ? "The widget left its page and was stopped"
              : "Unable to load the widget"}
          </Text>
        </View>
      ) : (
        <WebView<object>
          key={props.scriptHash}
          ref={webView}
          source={{ html }}
          accessibilityLabel={props.title ?? "Widget"}
          style={{ flex: 1, backgroundColor: "transparent" }}
          // Pinned to the inline document's scheme — never a wildcard.
          originWhitelist={["about:*"]}
          setSupportMultipleWindows={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          allowsBackForwardNavigationGestures={false}
          // The generated page loads exactly once, as about:blank; every other
          // request is a navigation the sandbox equivalent would forbid. Its
          // CSP already denies subframes (`default-src 'none'`).
          onShouldStartLoadWithRequest={(request) =>
            Platform.OS === "android" || request.url === "about:blank"
          }
          onNavigationStateChange={(navState) => stopIfNavigated(navState.url)}
          onContentProcessDidTerminate={() => setCrashed(true)}
          onRenderProcessGone={() => setCrashed(true)}
          onLoadEnd={() => setLoaded(true)}
          onError={() => setCrashed(true)}
          onHttpError={() => setCrashed(true)}
          onMessage={(event: WebViewMessageEvent) => {
            let message: unknown;
            try {
              message = JSON.parse(event.nativeEvent.data);
            } catch {
              return; // Not JSON: not a bridge message.
            }
            if (!Predicate.isObject(message)) return;
            hostRef.current?.receive(message);
          }}
        />
      )}
      {!loaded && !crashed && !navigatedAway ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : null}
      {host === null
        ? null
        : subscriptions.map((feed) => (
            <Fragment key={feed.name}>
              {renderFeed({
                feed,
                host,
                environmentId: props.environmentId,
                widgetId: props.widgetId,
                ...(props.refreshPolicy === undefined
                  ? {}
                  : { refreshPolicy: props.refreshPolicy }),
              })}
            </Fragment>
          ))}
    </View>
  );
}

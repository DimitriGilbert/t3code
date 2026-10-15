import type {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchWidgetBridgeManifest,
  WatchWidgetId,
  WatchWidgetRefreshPolicy,
} from "@t3tools/contracts";
import { isUnknownUnionMember } from "@t3tools/contracts";
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
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { watchEnvironment } from "../../state/watch";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

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
      // A stream item kind this build does not know (a newer server's
      // decode) carries nothing the widget could interpret — skip it rather
      // than posting a malformed envelope.
      if (isUnknownUnionMember(result.value)) return;
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
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );

  // One generated document per artifact — the same bytes web puts in srcdoc.
  const html = useMemo(
    () => buildWatchAppDocument({ bundle: props.bundle, scriptHash: props.scriptHash }),
    [props.bundle, props.scriptHash],
  );

  const live = { props, theme };
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
      // The frame always contributes the live theme; the caller's hostContext
      // extends or overrides it.
      hostContext: () => ({
        theme: latest.current.theme.appearance,
        styles: { variables: latest.current.theme.variables },
        ...latest.current.props.hostContext?.(),
      }),
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

  // The widget pulls context with T3.context(); these pushes are what re-fire
  // its T3.onContext listeners when what the host would answer changes. A push
  // posted before the document has loaded is simply missed — the pull covers
  // the initial value.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, props.hostContext]);

  // The bridge belongs to the generated document, which loads exactly once as
  // about:blank. `loads` counts main-frame load starts so a second one — a
  // navigation the JS gate failed to stop, `location.reload()`, an Android
  // callback timeout that failed open — stops the session instead of letting
  // a page T3 never generated pose as the widget. Web parity: the iframe's
  // `onLoad` counter in `WatchAppFrame`; the count, not the URL, is the check
  // so a same-URL reload counts too.
  const loads = useRef({ document: html, count: 0 });

  // One terminal teardown for every way the session dies: disposing the host
  // rides its closeName teardown (closeSubscription → feed unmount → atom
  // unsubscribe), and clearing `host` keeps the feed block from rendering.
  const stopSession = () => {
    hostRef.current?.dispose();
    hostRef.current = null;
    setHost(null);
  };

  const reportNavigatedAway = () =>
    latest.current.props.onViolation?.({
      code: "navigatedAway",
      message: "The widget document navigated away and was stopped.",
    });

  const onMainFrameLoadStart = () => {
    if (loads.current.document !== html) loads.current = { document: html, count: 0 };
    loads.current.count += 1;
    if (loads.current.count <= 1) return;
    stopSession();
    setNavigatedAway(true);
    reportNavigatedAway();
  };

  // Anything but the generated page's own `about:blank` means the widget left
  // its page; the bridge is dead either way, so stop it and say so.
  const stopIfNavigated = (url: string) => {
    if (navigatedAway || url === "about:blank" || url === "") return;
    stopSession();
    setNavigatedAway(true);
    reportNavigatedAway();
  };

  // Process death and load failure are terminal for the same reason a bad
  // navigation is: the page the bridge was talking to is gone.
  const onTerminalFault = () => {
    stopSession();
    setCrashed(true);
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
          // A wildcard on purpose: originWhitelist's *rejection* path hands
          // the URL to `Linking.openURL` on Android — an OS-browser exfil
          // channel the web sandbox does not have. Routing every request
          // through the JS callback below keeps the deny in our hands.
          originWhitelist={["*"]}
          setSupportMultipleWindows={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          allowsBackForwardNavigationGestures={false}
          // The JS gate, not the whitelist, is the enforcement point on both
          // platforms — the same contract as web: the generated page loads
          // exactly once, as about:blank, and every other request is denied —
          // including a second about:blank once the first load has started,
          // so even `location.reload()` is refused. A request that still gets
          // through (Android fails open if the callback never answers within
          // the native timeout — that platform limitation is covered by the
          // `watchAgentWidgetsMobile` kill switch) is caught by the load
          // counter below. Its CSP already denies subframes
          // (`default-src 'none'`).
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" &&
            (loads.current.document !== html || loads.current.count === 0)
          }
          onLoadStart={onMainFrameLoadStart}
          onNavigationStateChange={(navState) => stopIfNavigated(navState.url)}
          onContentProcessDidTerminate={onTerminalFault}
          onRenderProcessGone={onTerminalFault}
          onLoadEnd={() => setLoaded(true)}
          onError={onTerminalFault}
          onHttpError={onTerminalFault}
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
      {crashed || navigatedAway || host === null
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

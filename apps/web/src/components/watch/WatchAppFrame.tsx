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
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";
import { watchEnvironment } from "~/state/watch";

/**
 * A published agent-authored (or pack-shipped) watch widget in its hardened
 * sandbox. This deliberately does NOT reuse `McpAppFrame`: that host loads
 * documents by server-minted `src=` URL whose served document CSP
 * (`apps/server/src/http.ts` HTML_CONTENT_SECURITY_POLICY: `sandbox
 * allow-scripts allow-forms allow-popups allow-downloads`, no
 * `default-src 'none'`, no `connect-src 'none'`, no script-hash
 * authorization) permits popups, downloads and network access. Watch widgets
 * get a `srcdoc` frame, `sandbox="allow-scripts"` only (no
 * `allow-same-origin`, no forms), and a generated document whose CSP
 * hash-authorizes exactly the prelude and the artifact — zero network, no
 * credential-entry UI.
 */

export interface WatchAppFeedSubscription {
  readonly name: string;
  readonly instanceId: WatchConnectorInstanceId;
}

/** One bridge-opened data subscription; the feed pushes stream items into the host. */
export interface WatchAppFeedProps {
  readonly feed: WatchAppFeedSubscription;
  readonly host: WatchAppHost;
  readonly environmentId: EnvironmentId;
  readonly widgetId: WatchWidgetId;
  readonly refreshPolicy?: WatchWidgetRefreshPolicy;
}

export type WatchAppActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

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

export function WatchAppFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly widgetId: WatchWidgetId;
  /** The manifest the artifact was published with; every frame call is validated against it. */
  readonly manifest: WatchWidgetBridgeManifest;
  /** The emitted single-file bundle (injected verbatim, hash-authorized). */
  readonly bundle: string;
  /** The record's base64 SHA-256 of the bundle — the CSP hash-source. */
  readonly scriptHash: string;
  /** The connector instance the widget row binds; the only one its subscriptions may reach. */
  readonly connectorInstanceId?: WatchConnectorInstanceId;
  readonly refreshPolicy?: WatchWidgetRefreshPolicy;
  /** Declared actions the host implements; undeclared names never reach it. */
  readonly actions?: Readonly<Record<string, WatchAppActionHandler>>;
  /** Manifest breaches and foreign-instance calls surface here as widget errors. */
  readonly onViolation?: (violation: WatchAppBridgeViolation) => void;
  readonly hostContext?: () => Record<string, unknown>;
  readonly title?: string;
  readonly className?: string;
  /** Feed renderer seam (tests, non-connector feeds); defaults to the connector snapshot stream. */
  readonly renderFeed?: (props: WatchAppFeedProps) => ReactNode;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<WatchAppHost | null>(null);
  const [host, setHost] = useState<WatchAppHost | null>(null);
  const [subscriptions, setSubscriptions] = useState<ReadonlyArray<WatchAppFeedSubscription>>([]);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const theme = useHtmlRenderTheme();

  // One generated document per artifact — srcdoc identity is the artifact hash.
  const srcdoc = useMemo(
    () => buildWatchAppDocument({ bundle: props.bundle, scriptHash: props.scriptHash }),
    [props.bundle, props.scriptHash],
  );

  // A new document is a new session and resets the lifecycle flags — the
  // sanctioned "adjust state during render" pattern, no cascading effect.
  const [sessionDocument, setSessionDocument] = useState(srcdoc);
  if (sessionDocument !== srcdoc) {
    setSessionDocument(srcdoc);
    setNavigatedAway(false);
  }

  // Read by the host on every message, so it always sees current props
  // without being rebuilt (which would drop the widget's session).
  const live = { props, theme };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  // The bridge belongs to the generated document. A frame that navigates
  // keeps its window, so a second load stops the widget and unmounts the
  // frame rather than letting a page T3 never generated pose as the widget.
  // Enforcement lands on `load`: from the moment navigation starts until the
  // load fires, the departing document can still post to this host and receive
  // its posts — a bounded window no frame API closes earlier. Unmounting the
  // iframe is what ends it for real.
  const loads = useRef({ document: "", count: 0 });
  const onFrameLoad = () => {
    if (loads.current.document !== srcdoc) loads.current = { document: srcdoc, count: 0 };
    loads.current.count += 1;
    if (loads.current.count > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
      latest.current.props.onViolation?.({
        code: "navigatedAway",
        message: "The widget document navigated away and was stopped.",
      });
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = () => frameRef.current?.contentWindow ?? null;
    const next = makeWatchAppHost({
      manifest: latest.current.props.manifest,
      connectorInstanceId: () => latest.current.props.connectorInstanceId,
      // The document's origin is opaque, so "*" is the only target that
      // reaches it; the window reference scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
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
    const receive = (event: MessageEvent) => {
      // Only messages from this frame's own window reach its host.
      if (event.source !== null && event.source === target()) next.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      next.dispose();
      hostRef.current = null;
      setHost(null);
      setSubscriptions([]);
    };
    // A new document is a new widget session and needs a new host.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [srcdoc]);

  // The widget pulls context with T3.context(); these pushes are what re-fire
  // its T3.onContext listeners when what the host would answer changes. A push
  // posted before the document has loaded is simply missed — the pull covers
  // the initial value.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, props.hostContext]);

  const renderFeed =
    props.renderFeed ?? ((feed: WatchAppFeedProps) => <WatchAppConnectorFeed {...feed} />);

  return (
    <div className={cn("relative size-full overflow-hidden", props.className)}>
      {navigatedAway ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          The widget left its page and was stopped
        </p>
      ) : (
        <iframe
          ref={frameRef}
          title={props.title ?? "Widget"}
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
          className="size-full border-0 bg-transparent"
        />
      )}
      {navigatedAway || host === null
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
    </div>
  );
}

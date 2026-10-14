import {
  resolveWatchNotificationDelivery,
  WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
  watchNotificationDedupeKey,
  watchNotificationPresentation,
  watchNotificationThreadId,
  watchNotificationWidgetId,
} from "@t3tools/client-runtime/state/watch-notifications";
import {
  isUnknownUnionMember,
  type EnvironmentId,
  type WatchConnectorInstanceId,
  type WatchNotificationEvent,
  type WatchNotificationPrefs,
  type ThreadId,
  type UnknownUnionMember,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getClientSettings } from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useThreadShells } from "../state/entities";
import { watchEnvironment } from "../state/watch";
import { hasDesktopNotifications, setNotificationBadgeForSource } from "../threadNotifications";
import { toastManager } from "./ui/toast";
import { WATCH_NOTIFICATION_ICONS } from "./watch/notificationIcons";
import {
  addWatchNotificationUnread,
  addWatchThresholdAlert,
  setWatchNotificationPrefs,
} from "./watch/watchNotificationStore";

const NATIVE_BADGE_SOURCE = "watch";

const EMPTY_PREFS: WatchNotificationPrefs = {
  mutedEventTypes: [],
  mutedPageIds: [],
  snoozedUntil: null,
};

/**
 * Channel state survives remounts within the session: the dedupe sets and the
 * per-session channel id are the channel's identity — losing them on a remount
 * could re-deliver a notification the registry already emitted.
 */
interface SessionChannel {
  readonly inAppChannelId: string;
  readonly inAppDelivered: Set<string>;
  readonly nativeDelivered: Set<string>;
  prefs: WatchNotificationPrefs;
}

const sessionChannels = new Map<string, SessionChannel>();

function sessionChannelFor(environmentId: EnvironmentId): SessionChannel {
  const existing = sessionChannels.get(environmentId);
  if (existing !== undefined) return existing;
  const channel: SessionChannel = {
    inAppChannelId: `watch:${randomUUID()}`,
    inAppDelivered: new Set(),
    nativeDelivered: new Set(),
    prefs: EMPTY_PREFS,
  };
  sessionChannels.set(environmentId, channel);
  return channel;
}

/**
 * The watch notification router: subscribes each environment's notification
 * stream, runs the shared client-runtime delivery predicates, and renders the
 * surfaces — in-app toast + unread badge while attended, one device-native
 * `Notification` while unattended. Delivery is keyed `(notificationId,
 * channel)`; the in-app channel is this client session, the native channel is
 * the device singleton so several windows never double-fire.
 *
 * The atom registry subscription (not a React render) consumes the stream:
 * notifications are discrete events, and render batching must never drop one.
 */
export function WatchNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNativeNotification = useCallback(
    (environmentId: EnvironmentId, notification: Notification) => {
      pending.current.get(notification.tag)?.notification.close();
      pending.current.set(notification.tag, { environmentId, notification });
      setNotificationBadgeForSource(NATIVE_BADGE_SOURCE, pending.current.size);
    },
    [],
  );

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
      sessionChannels.delete(environmentId);
    }
    if (count !== pending.current.size) {
      setNotificationBadgeForSource(NATIVE_BADGE_SOURCE, pending.current.size);
    }
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadgeForSource(NATIVE_BADGE_SOURCE, 0);
    };
    clear();
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, []);

  return environmentIds.map((environmentId) => (
    <WatchEnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNativeNotification={onNativeNotification}
    />
  ));
}

function WatchEnvironmentNotifications(props: {
  readonly environmentId: EnvironmentId;
  readonly onNativeNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const threads = useThreadShells();
  // Connector instances label connector-scoped events ("Connector down: prod-db").
  const connectors = useEnvironmentQuery(
    watchEnvironment.connectorsLive({ environmentId, input: {} }),
  );

  // The stream callback reads the latest presentation lookups and route
  // params from this ref — it fires synchronously per stream item, outside
  // render, so render-captured values would go stale.
  const contextRef = useRef<{
    viewingThreadId: string | undefined;
    threadTitles: ReadonlyMap<ThreadId, string>;
    instanceLabels: ReadonlyMap<WatchConnectorInstanceId, string>;
    navigateToThread: (threadId: ThreadId) => void;
  }>({
    viewingThreadId: undefined,
    threadTitles: new Map(),
    instanceLabels: new Map(),
    navigateToThread: () => undefined,
  });
  // Ref write in an effect: the stream callback reads it lazily at emission
  // time, after commit, so it always sees the latest lookups.
  useEffect(() => {
    contextRef.current = {
      viewingThreadId:
        activeEnvironmentId === environmentId && activeThreadId !== undefined
          ? activeThreadId
          : undefined,
      threadTitles: new Map(
        threads
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => [thread.id, thread.title]),
      ),
      instanceLabels: new Map(
        (connectors.data?.instances ?? [])
          .filter((instance) => instance.archivedAt === null)
          .map((instance) => [instance.id, instance.name ?? instance.packId]),
      ),
      navigateToThread: (threadId) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      },
    };
  });

  const streamAtom = useMemo(
    () => watchEnvironment.notifications.live({ environmentId, input: {} }),
    [environmentId],
  );

  useEffect(
    () =>
      appAtomRegistry.subscribe(streamAtom, (result) => {
        const item = Option.getOrNull(AsyncResult.value(result));
        if (item === null) return;
        const channel = sessionChannelFor(environmentId);
        if (item.type === "prefs") {
          channel.prefs = item.prefs;
          setWatchNotificationPrefs(environmentId, item.prefs);
          return;
        }
        const notification = item.notification;
        // Unknown union members are undeliverable and unrenderable — narrow
        // before any field access.
        if (isUnknownUnionMember(notification)) return;
        // A threshold crossing is widget state, not a delivery decision: the
        // widget's header badge marks it even when this session surfaces no
        // toast or native notification (muted type, snooze, attended thread).
        const alertWidgetId = watchNotificationWidgetId(notification);
        if (alertWidgetId !== undefined) {
          addWatchThresholdAlert(environmentId, alertWidgetId);
        }
        const context = contextRef.current;
        const threadId = watchNotificationThreadId(notification);
        const threadTitle = threadId === undefined ? undefined : context.threadTitles.get(threadId);
        const instanceLabel =
          "instanceId" in notification && notification.instanceId !== undefined
            ? context.instanceLabels.get(notification.instanceId)
            : undefined;
        const presentation = watchNotificationPresentation({
          notification,
          threadTitle,
          instanceLabel,
        });
        if (presentation === null) return;
        const delivery = resolveWatchNotificationDelivery({
          notification,
          prefs: channel.prefs,
          now: Date.now(),
          inAppChannelId: channel.inAppChannelId,
          inAppDelivered: channel.inAppDelivered,
          nativeChannelId: WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
          nativeDelivered: channel.nativeDelivered,
          viewingThreadId: context.viewingThreadId,
          windowAttended: document.visibilityState === "visible" && document.hasFocus(),
        });
        if (!delivery.inApp && !delivery.desktopNative) return;
        if (delivery.inApp) {
          channel.inAppDelivered.add(
            watchNotificationDedupeKey(notification.notificationId, channel.inAppChannelId),
          );
        }
        if (delivery.desktopNative) {
          channel.nativeDelivered.add(
            watchNotificationDedupeKey(
              notification.notificationId,
              WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
            ),
          );
        }
        deliverNotification({
          delivery,
          presentation,
          notification,
          threadId,
          environmentId,
          navigateToThread: context.navigateToThread,
          onNativeNotification: props.onNativeNotification,
        });
      }),
    [streamAtom, environmentId, props.onNativeNotification],
  );

  return null;
}

function deliverNotification(input: {
  readonly delivery: { readonly inApp: boolean; readonly desktopNative: boolean };
  readonly presentation: NonNullable<ReturnType<typeof watchNotificationPresentation>>;
  readonly notification: Exclude<WatchNotificationEvent, UnknownUnionMember<string>>;
  readonly threadId: ThreadId | undefined;
  readonly environmentId: EnvironmentId;
  readonly navigateToThread: (threadId: ThreadId) => void;
  readonly onNativeNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const { delivery, presentation, notification, threadId, environmentId } = input;
  const settings = getClientSettings();

  // The unread badge is a surface of whichever channel actually delivered —
  // with in-app toasts or desktop notifications disabled, nothing accrues.
  if (delivery.inApp && settings.inAppNotificationsEnabled) {
    addWatchNotificationUnread(environmentId, notification.notificationId);
    const openThread =
      threadId === undefined
        ? undefined
        : () => {
            input.navigateToThread(threadId);
          };
    const toastId = toastManager.add({
      type: presentation.toastType,
      title: presentation.title,
      ...(presentation.body === undefined ? {} : { description: presentation.body }),
      data: {
        hideCopyButton: true,
        leadingIcon: WATCH_NOTIFICATION_ICONS[presentation.icon],
      },
      ...(openThread === undefined
        ? {}
        : {
            actionProps: {
              children: "Open thread",
              onClick: () => {
                toastManager.close(toastId);
                openThread();
              },
            },
          }),
    });
  }

  if (delivery.desktopNative && hasDesktopNotifications(settings.notificationMode)) {
    addWatchNotificationUnread(environmentId, notification.notificationId);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const native = new Notification(presentation.title, {
          ...(presentation.body === undefined ? {} : { body: presentation.body }),
          tag: `${NATIVE_BADGE_SOURCE}:${environmentId}:${notification.notificationId}`,
          silent: true,
        });
        input.onNativeNotification(environmentId, native);
        native.addEventListener("click", () => {
          native.close();
          window.focus();
          if (threadId !== undefined) input.navigateToThread(threadId);
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }
}

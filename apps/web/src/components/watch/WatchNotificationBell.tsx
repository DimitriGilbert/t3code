import { watchNotificationPresentation } from "@t3tools/client-runtime/state/watch-notifications";
import {
  isUnknownUnionMember,
  type EnvironmentId,
  type ThreadId,
  type WatchNotificationEventType,
  type WatchNotificationPrefs,
  type WatchPageId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { BellIcon, EllipsisIcon, MoonIcon, VolumeOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { requestCustomSnooze } from "~/components/CustomSnoozeDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useThreadShells } from "~/state/entities";
import { watchEnvironment } from "~/state/watch";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WATCH_NOTIFICATION_ICONS, WATCH_NOTIFICATION_TYPE_LABELS } from "./notificationIcons";
import {
  clearWatchNotificationUnread,
  revertWatchNotificationPrefs,
  setWatchNotificationPrefs,
  useWatchNotificationPrefs,
  useWatchUnreadCount,
} from "./watchNotificationStore";

const EMPTY_PREFS: WatchNotificationPrefs = {
  mutedEventTypes: [],
  mutedPageIds: [],
  snoozedUntil: null,
};

const EVENT_TYPES = Object.keys(
  WATCH_NOTIFICATION_TYPE_LABELS,
) as Array<WatchNotificationEventType>;

/** Future-facing counterpart to `formatRelativeTimeLabel` for the snooze row. */
function snoozeUntilLabel(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  if (ms <= 0) return "";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `for ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `for ${hours}h` : `for ${hours}h ${remainder}m`;
  }
  return `until ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso))}`;
}

/**
 * The header bell: unread badge plus a history/preferences popover. History
 * is server-recorded, so mute and snooze are delivery decisions — the popover
 * edits prefs through `notifications.setPrefs` and the stream replays them.
 * Opening the popover counts as viewing history and clears the badge.
 */
export function WatchNotificationBell(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const unread = useWatchUnreadCount(environmentId);
  const storedPrefs = useWatchNotificationPrefs(environmentId);
  // Prefs are a server-global singleton the stream echoes; until the first
  // echo lands there is no known base to compose a full-replace write on, so
  // the editing controls stay disabled.
  const prefsLoaded = storedPrefs !== null;
  const prefs = storedPrefs ?? EMPTY_PREFS;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"history" | "prefs">("history");
  const threads = useThreadShells(open);

  const history = useEnvironmentQuery(
    open ? watchEnvironment.notifications.history({ environmentId, input: {} }) : null,
  );
  const pages = useEnvironmentQuery(
    open && view === "prefs" ? watchEnvironment.pagesLive({ environmentId, input: {} }) : null,
  );
  const setPrefs = useAtomCommand(watchEnvironment.notifications.setPrefs, {
    reportFailure: true,
  });

  // Opening the popover is viewing history — the badge clears.
  useEffect(() => {
    if (open) clearWatchNotificationUnread(environmentId);
  }, [open, environmentId]);

  const updatePrefs = (next: WatchNotificationPrefs) => {
    const previous = storedPrefs;
    // Optimistic write: consecutive toggles inside one echo round-trip must
    // compose against the newest local view, not the last echoed snapshot.
    setWatchNotificationPrefs(environmentId, next);
    void setPrefs({ environmentId, input: next }).then((result) => {
      // A failed write gets no echo; restore the last server-known prefs,
      // unless a newer write already replaced this optimistic value.
      if (AsyncResult.isFailure(result)) {
        revertWatchNotificationPrefs(environmentId, next, previous);
      }
    });
  };

  const toggleMutedType = (type: WatchNotificationEventType) => {
    updatePrefs({
      ...prefs,
      mutedEventTypes: prefs.mutedEventTypes.includes(type)
        ? prefs.mutedEventTypes.filter((entry) => entry !== type)
        : [...prefs.mutedEventTypes, type],
    });
  };

  const toggleMutedPage = (pageId: WatchPageId) => {
    updatePrefs({
      ...prefs,
      mutedPageIds: prefs.mutedPageIds.includes(pageId)
        ? prefs.mutedPageIds.filter((entry) => entry !== pageId)
        : [...prefs.mutedPageIds, pageId],
    });
  };

  const snoozeOneHour = () => {
    updatePrefs({ ...prefs, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  };

  const nowMs = Date.parse(useNowMinute());
  const snoozed = prefs.snoozedUntil !== null && Date.parse(prefs.snoozedUntil) > nowMs;
  const threadTitles = new Map<ThreadId, string>(
    threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => [thread.id, thread.title]),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label="Notifications" className="relative">
            <BellIcon />
            {unread === 0 ? null : (
              <Badge
                size="sm"
                variant="default"
                className="absolute -top-1 -right-1"
                aria-label={`${unread} unread notifications`}
              >
                {unread > 9 ? "9+" : unread}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverPopup width="md" align="end" padding="none" className="overflow-hidden">
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <PopoverTitle>Notifications</PopoverTitle>
            <ToggleGroup
              aria-label="Notification view"
              value={[view]}
              onValueChange={(next) => {
                if (next[0] === "history" || next[0] === "prefs") setView(next[0]);
              }}
            >
              <Toggle value="history">History</Toggle>
              <Toggle value="prefs">Prefs</Toggle>
            </ToggleGroup>
          </div>
          {view === "history" ? (
            <div className="border-t border-border/60">
              <ScrollArea className="max-h-80">
                {history.isPending ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
                ) : (history.data?.entries.length ?? 0) === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No notifications yet.
                  </p>
                ) : (
                  <ul className="flex flex-col py-1">
                    {history.data?.entries.map((entry) => {
                      const notification = entry.notification;
                      if (isUnknownUnionMember(notification)) return null;
                      const threadId =
                        "threadId" in notification ? notification.threadId : undefined;
                      const presentation = watchNotificationPresentation({
                        notification,
                        threadTitle:
                          threadId === undefined ? undefined : threadTitles.get(threadId),
                      });
                      if (presentation === null) return null;
                      const typeMuted = prefs.mutedEventTypes.some(
                        (type) => type === notification.type,
                      );
                      return (
                        <li
                          key={notification.notificationId}
                          className="group flex items-start gap-2.5 px-3 py-2 hover:bg-accent/50"
                        >
                          <span className="mt-0.5 shrink-0">
                            {WATCH_NOTIFICATION_ICONS[presentation.icon]}
                          </span>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                            {...(threadId === undefined
                              ? { disabled: true }
                              : {
                                  onClick: () => {
                                    setOpen(false);
                                    void navigate({
                                      to: "/$environmentId/$threadId",
                                      params: { environmentId, threadId },
                                    });
                                  },
                                })}
                          >
                            <span className="truncate text-xs font-medium">
                              {presentation.title}
                            </span>
                            {presentation.body === undefined ? null : (
                              <span className="truncate text-2xs text-muted-foreground">
                                {presentation.body}
                              </span>
                            )}
                            <span className="text-2xs text-muted-foreground/80">
                              {formatRelativeTimeLabel(notification.createdAt)}
                            </span>
                          </button>
                          <Menu>
                            <MenuTrigger
                              render={
                                <span className="inline-flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Notification actions"
                                  >
                                    <EllipsisIcon />
                                  </Button>
                                </span>
                              }
                            />
                            <MenuPopup>
                              {threadId === undefined ? null : (
                                <MenuItem
                                  onClick={() => {
                                    setOpen(false);
                                    void navigate({
                                      to: "/$environmentId/$threadId",
                                      params: { environmentId, threadId },
                                    });
                                  }}
                                >
                                  Open thread
                                </MenuItem>
                              )}
                              <MenuItem
                                disabled={!prefsLoaded}
                                onClick={() => toggleMutedType(notification.type)}
                              >
                                {typeMuted
                                  ? `Unmute ${WATCH_NOTIFICATION_TYPE_LABELS[notification.type]}`
                                  : `Mute ${WATCH_NOTIFICATION_TYPE_LABELS[notification.type]}`}
                              </MenuItem>
                              <MenuItem disabled={!prefsLoaded} onClick={snoozeOneHour}>
                                Snooze for an hour
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </ScrollArea>
            </div>
          ) : (
            <div className="border-t border-border/60">
              <ScrollArea className="max-h-80">
                <div className="flex flex-col gap-1 px-3 py-2">
                  <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                    Types
                  </span>
                  {EVENT_TYPES.map((type) => {
                    const muted = prefs.mutedEventTypes.includes(type);
                    return (
                      <label
                        key={type}
                        className="flex min-h-7 cursor-pointer items-center justify-between gap-2"
                      >
                        <span className="flex items-center gap-1.5 text-xs">
                          {muted ? (
                            <VolumeOffIcon className="size-3 text-muted-foreground" aria-hidden />
                          ) : null}
                          {WATCH_NOTIFICATION_TYPE_LABELS[type]}
                        </span>
                        <Switch
                          size="sm"
                          checked={!muted}
                          disabled={!prefsLoaded}
                          onCheckedChange={() => toggleMutedType(type)}
                          aria-label={`${WATCH_NOTIFICATION_TYPE_LABELS[type]} notifications`}
                        />
                      </label>
                    );
                  })}
                  {(pages.data?.pages.length ?? 0) === 0 ? null : (
                    <>
                      <span className="mt-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                        Pages
                      </span>
                      {pages.data?.pages.map((page) => {
                        const muted = prefs.mutedPageIds.includes(page.id);
                        return (
                          <label
                            key={page.id}
                            className="flex min-h-7 cursor-pointer items-center justify-between gap-2"
                          >
                            <span className="flex items-center gap-1.5 text-xs">
                              {muted ? (
                                <VolumeOffIcon
                                  className="size-3 text-muted-foreground"
                                  aria-hidden
                                />
                              ) : null}
                              {page.name}
                            </span>
                            <Switch
                              size="sm"
                              checked={!muted}
                              disabled={!prefsLoaded}
                              onCheckedChange={() => toggleMutedPage(page.id)}
                              aria-label={`${page.name} notifications`}
                            />
                          </label>
                        );
                      })}
                    </>
                  )}
                  <Separator className="my-1.5" />
                  <div className="flex items-center justify-between gap-2 pb-1">
                    <span className="flex items-center gap-1.5 text-xs">
                      <MoonIcon className="size-3 text-muted-foreground" aria-hidden />
                      {snoozed && prefs.snoozedUntil !== null
                        ? `Snoozed ${snoozeUntilLabel(prefs.snoozedUntil, nowMs)}`
                        : "Snooze all"}
                    </span>
                    {snoozed ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!prefsLoaded}
                        onClick={() => updatePrefs({ ...prefs, snoozedUntil: null })}
                      >
                        Resume
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!prefsLoaded}
                        onClick={() => {
                          void requestCustomSnooze().then((choice) => {
                            if (choice === null) return;
                            updatePrefs({ ...prefs, snoozedUntil: choice.snoozedUntil });
                          });
                        }}
                      >
                        Snooze…
                      </Button>
                    )}
                  </div>
                </div>
              </ScrollArea>
            </div>
          )}
          {history.error === null ? null : (
            <p className="border-t border-border/60 px-3 py-2 text-2xs text-destructive-foreground">
              {history.error}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

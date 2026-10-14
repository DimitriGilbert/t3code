import type { WatchNotificationIconKind } from "@t3tools/client-runtime/state/watch-notifications";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  Undo2Icon,
  UnplugIcon,
} from "lucide-react";
import type { ReactNode } from "react";

/** One glyph per notification icon kind — shared by toasts and history rows. */
export const WATCH_NOTIFICATION_ICONS: Record<WatchNotificationIconKind, ReactNode> = {
  completed: <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />,
  failed: <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />,
  input: <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />,
  connector: <UnplugIcon aria-hidden className="size-4 text-warning-foreground" />,
  rollback: <Undo2Icon aria-hidden className="size-4 text-info-foreground" />,
  threshold: <GaugeIcon aria-hidden className="size-4 text-warning-foreground" />,
};

/** Human labels per event type for the preferences view and mute actions. */
export const WATCH_NOTIFICATION_TYPE_LABELS = {
  "thread.completed": "Thread completed",
  "thread.failed": "Thread failed",
  "thread.awaitingInput": "Input needed",
  "connector.unhealthy": "Connector down",
  "connector.authExpired": "Credentials expired",
  "connector.rolledBack": "Connector rolled back",
  "widget.threshold": "Widget threshold",
} as const;

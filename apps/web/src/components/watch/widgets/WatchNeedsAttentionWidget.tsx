import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  watchAttentionItems,
  watchWidgetSettingBoolean,
  watchWidgetSettingNumber,
  type WatchAttentionItem,
  type WatchAttentionReason,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScopedThreadRef, WatchWidget } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  CircleCheckIcon,
  ClockIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  TimerOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { requestCustomSnooze } from "~/components/CustomSnoozeDialog";
import { resolveSnoozePresets } from "~/components/Sidebar.snooze";
import { useThreadActions } from "~/hooks/useThreadActions";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

const REASON_PRESENTATION: Record<
  WatchAttentionReason,
  { readonly label: string; readonly badge: "error" | "warning" | "info" }
> = {
  failed: { label: "Failed", badge: "error" },
  approval: { label: "Needs approval", badge: "warning" },
  input: { label: "Awaiting input", badge: "warning" },
  plan: { label: "Plan ready", badge: "info" },
  unread: { label: "Unread", badge: "info" },
  stale: { label: "Stale", badge: "warning" },
};

const REASON_ICON: Record<WatchAttentionReason, typeof TriangleAlertIcon> = {
  failed: TriangleAlertIcon,
  approval: ShieldAlertIcon,
  input: MessageCircleQuestionIcon,
  plan: CircleCheckIcon,
  unread: MailIcon,
  stale: ClockIcon,
};

function SnoozeMenu(props: {
  readonly timestampFormat: TimestampFormat;
  readonly onSnooze: (until: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<ReturnType<typeof resolveSnoozePresets>>([]);
  // Presets resolve at open time so "In 1 hour" is relative to the click.
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPresets(resolveSnoozePresets(new Date(), props.timestampFormat));
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            />
          }
        >
          <ClockIcon />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              props.onSnooze(preset.snoozedUntil);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) props.onSnooze(choice.snoozedUntil);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function AttentionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WatchAttentionItem;
  readonly snoozed: boolean;
  readonly snoozeSupported: boolean;
  readonly canSnoozeThread: boolean;
  readonly projectTitle: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly onSnooze: (ref: ScopedThreadRef, until: string) => void;
  readonly onUnsnooze: (ref: ScopedThreadRef) => void;
}) {
  const { item } = props;
  const thread = item.thread;
  const threadRef = scopeThreadRef(props.environmentId, thread.id);
  const relative = formatRelativeTimeLabel(thread.updatedAt);

  return (
    <WatchWidgetRow
      title={thread.title}
      onOpen={() => props.onOpen(threadRef)}
      className={props.snoozed ? "opacity-60" : undefined}
      meta={
        <>
          {props.projectTitle === null ? null : (
            <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
              {props.projectTitle}
            </span>
          )}
          {item.reasons.slice(0, 2).map((reason) => {
            const presentation = REASON_PRESENTATION[reason];
            const ReasonIcon = REASON_ICON[reason];
            return (
              <Badge key={reason} size="sm" variant={presentation.badge}>
                <ReasonIcon className="size-2.5" />
                {presentation.label}
              </Badge>
            );
          })}
          {relative !== "" && (
            <span className="shrink-0 text-2xs text-muted-foreground">{relative}</span>
          )}
        </>
      }
      actions={
        props.snoozed ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label={`Unsnooze ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onUnsnooze(threadRef);
                  }}
                />
              }
            >
              <TimerOffIcon />
            </TooltipTrigger>
            <TooltipPopup>Bring back to attention</TooltipPopup>
          </Tooltip>
        ) : props.snoozeSupported && props.canSnoozeThread ? (
          <SnoozeMenu
            timestampFormat={props.timestampFormat}
            onSnooze={(until) => props.onSnooze(threadRef, until)}
          />
        ) : undefined
      }
    />
  );
}

/**
 * Failed runs, parked approvals/user questions, stale threads, and unread
 * completions on the bound projects — anything that wants a human decision.
 * Snooze rides the existing thread-snooze command (presets + the custom
 */
export function WatchNeedsAttentionWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozeSupported: boolean;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const nowIso = useNowMinute();
  const settings = useEnvironmentSettings(props.environmentId);
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const staleAfterHours = watchWidgetSettingNumber(props.widget, "staleAfterHours", 24, {
    min: 1,
    max: 720,
  });
  const showSnoozed = watchWidgetSettingBoolean(props.widget, "showSnoozed", true);
  const { items, snoozed } = watchAttentionItems(props.threads, {
    projectId: props.projectId,
    now: nowIso,
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
    maxItems,
  });
  const visible = showSnoozed ? [...items, ...snoozed] : items;
  const { snoozeThread, unsnoozeThread } = useThreadActions();
  const onSnooze = (ref: ScopedThreadRef, until: string) => void snoozeThread(ref, until);
  const onUnsnooze = (ref: ScopedThreadRef) => void unsnoozeThread(ref);

  if (visible.length === 0) {
    return <WatchWidgetEmpty text="Nothing needs attention" />;
  }
  return (
    <WatchWidgetRows>
      {visible.map((item) => (
        <AttentionRow
          key={item.thread.id}
          environmentId={props.environmentId}
          item={item}
          snoozed={snoozed.includes(item)}
          snoozeSupported={props.snoozeSupported}
          canSnoozeThread={canSnooze(item.thread, { now: nowIso })}
          projectTitle={
            props.showProjectBadge
              ? (props.projectTitleById.get(item.thread.projectId) ?? null)
              : null
          }
          timestampFormat={settings.timestampFormat}
          onOpen={props.onOpenThread}
          onSnooze={onSnooze}
          onUnsnooze={onUnsnooze}
        />
      ))}
    </WatchWidgetRows>
  );
}

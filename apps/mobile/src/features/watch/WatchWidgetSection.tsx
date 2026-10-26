import { watchWidgetDisplayTitle } from "@t3tools/client-runtime/state/watch-pages";
import { watchWidgetProvenanceMarker } from "@t3tools/client-runtime/state/watch-pages";
import {
  watchWidgetErrorPresentation,
  type WatchWidgetErrorActionId,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { WatchWidget, WatchWidgetErrorState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

/**
 * One card in the mobile single-column stack. The header carries the widget
 * title and provenance marker; in edit mode it gains the only write surface
 * mobile has — move up/down and hide — which all write `mobileOrder`/
 * `mobileHidden` through `setMobileProjection`, never `setLayout`.
 */
export function WatchWidgetSection(props: {
  readonly widget: WatchWidget;
  /** Edit mode shows the projection controls and keeps hidden rows mounted. */
  readonly editing: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onMove: (direction: "up" | "down") => void;
  readonly onHide: () => void;
  readonly children: ReactNode;
}) {
  const marker = watchWidgetProvenanceMarker(props.widget.provenance);
  const editButton = (input: {
    readonly icon: AppSymbolName;
    readonly label: string;
    readonly onPress: () => void;
    readonly disabled?: boolean;
  }) => (
    <Pressable
      key={input.label}
      accessibilityRole="button"
      accessibilityLabel={input.label}
      accessibilityState={{ disabled: input.disabled }}
      disabled={input.disabled}
      onPress={input.onPress}
      className={cn(
        "size-8 items-center justify-center rounded-full",
        input.disabled ? "opacity-30" : "active:bg-row-hover",
      )}
    >
      <SymbolView name={input.icon} size={16} tintColorClassName="accent-foreground" />
    </Pressable>
  );

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {watchWidgetDisplayTitle(props.widget)}
        </Text>
        {marker === null ? null : (
          <View className="rounded-full border border-border px-1.5 py-0.5">
            <Text className="text-2xs font-t3-medium uppercase tracking-wide text-foreground-muted">
              {marker}
            </Text>
          </View>
        )}
        {props.editing ? (
          <View className="flex-row items-center gap-0.5">
            {editButton({
              icon: "chevron.up",
              label: `Move ${watchWidgetDisplayTitle(props.widget)} up`,
              onPress: () => props.onMove("up"),
              disabled: !props.canMoveUp,
            })}
            {editButton({
              icon: "chevron.down",
              label: `Move ${watchWidgetDisplayTitle(props.widget)} down`,
              onPress: () => props.onMove("down"),
              disabled: !props.canMoveDown,
            })}
            {editButton({
              icon: "eye.slash",
              label: `Hide ${watchWidgetDisplayTitle(props.widget)} on mobile`,
              onPress: props.onHide,
            })}
          </View>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

/**
 * The typed source/config error a widget degrades to — the same copy table as
 * web (`watchWidgetErrorPresentation`). Mobile only keeps the actions that
 * work without the configure form: `reconnect` re-sends the bound instance's
 */
export function WatchWidgetErrorBody(props: {
  readonly error: WatchWidgetErrorState;
  /** Present only when a bound connector instance can be reconnected here. */
  readonly onReconnect?: () => void;
}) {
  const presentation = watchWidgetErrorPresentation(props.error);
  const hiddenActions: ReadonlyArray<WatchWidgetErrorActionId> = [
    "configure",
    "repoint",
    "view-source",
    "remove",
    "update-secret",
    ...(props.onReconnect === undefined ? (["reconnect"] as const) : []),
  ];
  const action =
    presentation.action !== undefined && !hiddenActions.includes(presentation.action.id)
      ? presentation.action
      : undefined;
  return (
    <View className="gap-2 px-3 py-4">
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="exclamationmark.triangle"
          size={14}
          tintColorClassName={
            presentation.variant === "error"
              ? "accent-danger-foreground"
              : presentation.variant === "warning"
                ? "accent-warning-foreground"
                : "accent-icon-muted"
          }
        />
        <Text
          className={cn(
            "text-sm",
            presentation.variant === "error"
              ? "text-danger-foreground"
              : presentation.variant === "warning"
                ? "text-warning-foreground"
                : "text-foreground-muted",
          )}
        >
          {presentation.line}
        </Text>
      </View>
      {action?.id === "reconnect" && props.onReconnect !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={props.onReconnect}
          className="self-start rounded-full border border-border px-3 py-1.5 active:bg-row-hover"
        >
          <Text className="text-xs font-t3-medium text-foreground">{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

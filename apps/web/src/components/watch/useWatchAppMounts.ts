import {
  makeWatchAppMountRegistry,
  watchAgentSourceId,
  type WatchAppMountChange,
  type WatchAppMountState,
} from "@t3tools/client-runtime/state/watch-mounts";
import type { WatchWidget, WatchWidgetId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The board-side half of agent-frame mount governance: one
 * `WatchAppMountRegistry` per (environment, page) — a page switch or
 * environment swap reseats every widget through fresh visibility reports —
 * plus the React state the registry's change list drives.
 * `WatchAppWidget` reports `IntersectionObserver` entries through
 * `reportVisibility`; `stateOf` is what each widget renders with.
 */
export function useWatchAppMounts(input: {
  readonly registryKey: string;
  readonly widgets: ReadonlyArray<Pick<WatchWidget, "id" | "kind">>;
}) {
  const { widgets, registryKey } = input;
  // The key is the registry's identity: a new environment/page reseats every
  // widget through fresh visibility reports; registry and states reset
  // together during render so nothing renders mounted before its first
  // intersection entry lands.
  const [bound, setBound] = useState(() => ({
    key: registryKey,
    registry: makeWatchAppMountRegistry(),
    states: {} as Readonly<Record<string, WatchAppMountState>>,
  }));
  if (bound.key !== registryKey) {
    setBound({
      key: registryKey,
      registry: makeWatchAppMountRegistry(),
      states: {},
    });
  }
  const registry = bound.registry;
  const states = bound.states;

  const applyChanges = useCallback((changes: ReadonlyArray<WatchAppMountChange>) => {
    if (changes.length === 0) return;
    setBound((current) => {
      const next = { ...current.states };
      for (const change of changes) next[change.id] = change.state;
      return { ...current, states: next };
    });
  }, []);

  // Widgets removed from the page release their mount seat and can promote a
  // standby placeholder without waiting for a visibility change.
  const trackedIdsRef = useRef<ReadonlySet<WatchWidgetId>>(new Set());
  const trackedKeyRef = useRef(registryKey);
  useEffect(() => {
    if (trackedKeyRef.current !== registryKey) {
      trackedKeyRef.current = registryKey;
      trackedIdsRef.current = new Set();
    }
    const nextIds = new Set(
      widgets
        .filter((widget) => watchAgentSourceId(widget.kind) !== undefined)
        .map((widget) => widget.id),
    );
    const changes: Array<WatchAppMountChange> = [];
    for (const id of trackedIdsRef.current) {
      if (!nextIds.has(id)) changes.push(...registry.remove(id));
    }
    trackedIdsRef.current = nextIds;
    // Syncing the mutable registry into render state is the effect's job.
    // oxlint-disable-next-line react/set-state-in-effect
    applyChanges(changes);
  }, [registryKey, registry, widgets, applyChanges]);

  // Only `agent:` kinds hold mount seats — a stray report for a first-party
  // widget must not occupy one.
  const reportVisibility = useCallback(
    (widgetId: WatchWidgetId, visible: boolean) => {
      const widget = widgets.find((entry) => entry.id === widgetId);
      if (widget === undefined || watchAgentSourceId(widget.kind) === undefined) return;
      applyChanges(visible ? registry.setVisible(widgetId) : registry.setHidden(widgetId));
    },
    [applyChanges, registry, widgets],
  );

  const requestMount = useCallback(
    (widgetId: WatchWidgetId) => {
      const widget = widgets.find((entry) => entry.id === widgetId);
      if (widget === undefined || watchAgentSourceId(widget.kind) === undefined) return;
      applyChanges(registry.requestMount(widgetId));
    },
    [applyChanges, registry, widgets],
  );

  const stateOf = useCallback(
    (widgetId: WatchWidgetId): WatchAppMountState => states[widgetId] ?? "unmounted",
    [states],
  );

  return { stateOf, reportVisibility, requestMount } as const;
}

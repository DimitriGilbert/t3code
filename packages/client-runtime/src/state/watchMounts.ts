import {
  WatchConnectorPackId,
  type WatchPackWidgetSource,
  type WatchWidgetKind,
  type WatchWidgetProvenance,
  WatchWidgetSourceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Mount governance for agent-authored watch widgets: at most
 * `WATCH_APP_MOUNT_LIMIT` frames mount at once, a widget mounts lazily when it
 * becomes visible, the least-recently-visible mounted widget is evicted to a
 * "tap to load" placeholder past the cap, and an offscreen widget is fully
 * unmounted. This is pure logic — the shell reports visibility and applies the
 * returned state changes; no DOM lives here.
 */
export const WATCH_APP_MOUNT_LIMIT = 6;

export type WatchAppMountState = "mounted" | "placeholder" | "unmounted";

export interface WatchAppMountChange {
  readonly id: string;
  readonly state: WatchAppMountState;
}

export interface WatchAppMountRegistry {
  /** Report a widget scrolling into view; mounts it, evicting the LRU past the cap. */
  readonly setVisible: (id: string) => ReadonlyArray<WatchAppMountChange>;
  /** Report a widget leaving view; fully unmounts it and promotes a waiting visible one. */
  readonly setHidden: (id: string) => ReadonlyArray<WatchAppMountChange>;
  /** The user tapped a placeholder; mounts it immediately, evicting the LRU. */
  readonly requestMount: (id: string) => ReadonlyArray<WatchAppMountChange>;
  /** Stop tracking a widget (removed from the page or set). */
  readonly remove: (id: string) => ReadonlyArray<WatchAppMountChange>;
  readonly stateOf: (id: string) => WatchAppMountState;
  /** The mounted ids, most recently visible first. */
  readonly mounted: () => ReadonlyArray<string>;
}

export function makeWatchAppMountRegistry(limit = WATCH_APP_MOUNT_LIMIT): WatchAppMountRegistry {
  // `mounted` is ordered by visibility recency (front = most recently seen);
  // `standby` holds visible-but-evicted placeholders, front = next promoted.
  const mountedIds: Array<string> = [];
  const standbyIds: Array<string> = [];

  const evictOverLimit = (changes: Array<WatchAppMountChange>) => {
    while (mountedIds.length > limit) {
      const evicted = mountedIds.pop();
      if (evicted === undefined) return;
      standbyIds.unshift(evicted);
      changes.push({ id: evicted, state: "placeholder" });
    }
  };

  const mount = (id: string, changes: Array<WatchAppMountChange>) => {
    mountedIds.unshift(id);
    changes.push({ id, state: "mounted" });
    evictOverLimit(changes);
  };

  // A waiting placeholder only exists while more than `limit` widgets are
  // visible; when a slot frees, the freshest standby mounts on its own —
  // "tap to load" is what >limit visibility requires, not a permanent state.
  const promoteStandby = (changes: Array<WatchAppMountChange>) => {
    while (mountedIds.length < limit && standbyIds.length > 0) {
      const id = standbyIds.shift();
      if (id === undefined) return;
      // It keeps its LRU seat: it was the least recently visible before.
      mountedIds.push(id);
      changes.push({ id, state: "mounted" });
    }
  };

  const bump = (id: string, list: Array<string>) => {
    const index = list.indexOf(id);
    if (index > 0) {
      list.splice(index, 1);
      list.unshift(id);
    }
  };

  return {
    setVisible: (id) => {
      const changes: Array<WatchAppMountChange> = [];
      if (mountedIds.includes(id)) {
        bump(id, mountedIds);
        return changes;
      }
      const standbyIndex = standbyIds.indexOf(id);
      if (standbyIndex >= 0) {
        standbyIds.splice(standbyIndex, 1);
        if (mountedIds.length < limit) {
          mount(id, changes);
        } else {
          standbyIds.unshift(id);
        }
        return changes;
      }
      mount(id, changes);
      return changes;
    },
    setHidden: (id) => {
      const changes: Array<WatchAppMountChange> = [];
      const mountedIndex = mountedIds.indexOf(id);
      if (mountedIndex >= 0) {
        mountedIds.splice(mountedIndex, 1);
        changes.push({ id, state: "unmounted" });
        promoteStandby(changes);
        return changes;
      }
      const standbyIndex = standbyIds.indexOf(id);
      if (standbyIndex >= 0) {
        standbyIds.splice(standbyIndex, 1);
        changes.push({ id, state: "unmounted" });
      }
      return changes;
    },
    requestMount: (id) => {
      const changes: Array<WatchAppMountChange> = [];
      if (mountedIds.includes(id)) {
        bump(id, mountedIds);
        return changes;
      }
      const standbyIndex = standbyIds.indexOf(id);
      if (standbyIndex >= 0) standbyIds.splice(standbyIndex, 1);
      mount(id, changes);
      return changes;
    },
    remove: (id) => {
      const changes: Array<WatchAppMountChange> = [];
      const mountedIndex = mountedIds.indexOf(id);
      if (mountedIndex >= 0) {
        mountedIds.splice(mountedIndex, 1);
        changes.push({ id, state: "unmounted" });
        promoteStandby(changes);
        return changes;
      }
      const standbyIndex = standbyIds.indexOf(id);
      if (standbyIndex >= 0) {
        standbyIds.splice(standbyIndex, 1);
        changes.push({ id, state: "unmounted" });
      }
      return changes;
    },
    stateOf: (id) =>
      mountedIds.includes(id) ? "mounted" : standbyIds.includes(id) ? "placeholder" : "unmounted",
    mounted: () => [...mountedIds],
  };
}

// ── Agent-kind resolution ────────────────────────────────────────────────

const AGENT_KIND_PREFIX = "agent:";
const PACK_PROVENANCE_PREFIX = "pack:";
const isSourceId = Schema.is(WatchWidgetSourceId);
const isPackId = Schema.is(WatchConnectorPackId);

/**
 * The published source a widget kind points at, or `undefined` for first-party
 * registry kinds and malformed `agent:` kinds (a kind naming nothing is
 * treated as missing, never trusted through).
 */
export function watchAgentSourceId(kind: WatchWidgetKind): WatchWidgetSourceId | undefined {
  if (!kind.startsWith(AGENT_KIND_PREFIX)) return undefined;
  const candidate = kind.slice(AGENT_KIND_PREFIX.length);
  return isSourceId(candidate) ? candidate : undefined;
}

/**
 * Whether a pack-provenance widget's pack registration is gone — uninstalled
 * (soft-archived) or purged (absent). The shell renders `connectorMissing` for
 * it, config intact. Only `pack:*` provenance consults the registration list;
 * `agentPublished` widgets live in the artifact cache and are resolved there.
 */
export function isMissingPackWidgetKind(input: {
  readonly kind: WatchWidgetKind;
  readonly provenance: WatchWidgetProvenance;
  readonly widgetSources: ReadonlyArray<WatchPackWidgetSource>;
}): boolean {
  if (!input.provenance.startsWith(PACK_PROVENANCE_PREFIX)) return false;
  const packIdPart = input.provenance.slice(PACK_PROVENANCE_PREFIX.length);
  const packId = isPackId(packIdPart) ? packIdPart : undefined;
  if (packId === undefined) return true;
  const sourceId = watchAgentSourceId(input.kind);
  if (sourceId === undefined) return true;
  const registration = input.widgetSources.find(
    (source) => source.packId === packId && source.sourceId === sourceId,
  );
  return registration === undefined || registration.archivedAt !== null;
}

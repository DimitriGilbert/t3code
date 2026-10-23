/**
 * Tiny intent bus between app-level entry points (command palette,
 * keybindings, menus) and the mounted /watch screen. Actions emitted while no
 * screen is listening — e.g. fired right before navigating to /watch — are
 */
export type WatchUiAction =
  | "new-page"
  | "toggle-edit"
  | "add-widget"
  | "switch-page"
  | "open-gallery";

type WatchUiListener = (action: WatchUiAction) => void;

/** Post-navigation delivery window — generous for a route mount, useless for lurking intent. */
const QUEUED_ACTION_TTL_MS = 5_000;
/** Hard bound on queued actions; oldest are dropped first. */
const MAX_QUEUED_ACTIONS = 8;

const listeners = new Set<WatchUiListener>();
const pending: Array<{ readonly action: WatchUiAction; readonly at: number }> = [];

export function emitWatchUiAction(action: WatchUiAction): void {
  if (listeners.size === 0) {
    pending.push({ action, at: Date.now() });
    if (pending.length > MAX_QUEUED_ACTIONS) {
      pending.splice(0, pending.length - MAX_QUEUED_ACTIONS);
    }
    return;
  }
  for (const listener of listeners) listener(action);
}

/**
 * Registers the screen's handler and replays queued actions still inside
 * their TTL. The flush always drains the backlog — expired entries die here
 * rather than waiting for the next mount.
 */
export function onWatchUiAction(listener: WatchUiListener): () => void {
  listeners.add(listener);
  const now = Date.now();
  for (const entry of pending.splice(0)) {
    if (now - entry.at <= QUEUED_ACTION_TTL_MS) listener(entry.action);
  }
  return () => {
    listeners.delete(listener);
  };
}

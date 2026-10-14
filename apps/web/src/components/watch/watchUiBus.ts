/**
 * Tiny intent bus between app-level entry points (command palette,
 * keybindings, menus) and the mounted /watch screen. Actions emitted while no
 * screen is listening — e.g. fired right before navigating to /watch — are
 * queued and delivered when the screen mounts its listener.
 */
export type WatchUiAction =
  | "new-page"
  | "toggle-edit"
  | "add-widget"
  | "switch-page"
  | "open-gallery";

type WatchUiListener = (action: WatchUiAction) => void;

const listeners = new Set<WatchUiListener>();
const pending: WatchUiAction[] = [];

export function emitWatchUiAction(action: WatchUiAction): void {
  if (listeners.size === 0) {
    pending.push(action);
    return;
  }
  for (const listener of listeners) listener(action);
}

/** Registers the screen's handler and replays queued actions. */
export function onWatchUiAction(listener: WatchUiListener): () => void {
  listeners.add(listener);
  for (const action of pending.splice(0)) listener(action);
  return () => {
    listeners.delete(listener);
  };
}

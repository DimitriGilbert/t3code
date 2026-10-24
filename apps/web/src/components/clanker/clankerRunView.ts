import type { ClankerRunStatus, ClankerStepState, ClankerStepStatus } from "@t3tools/contracts";

/** A step card's place in the run: its wave, if the workflow still declares one. */
export interface ClankerStepRow {
  readonly stepName: string;
  /** 1-based wave, or `null` when the workflow no longer declares the step. */
  readonly wave: number | null;
  readonly state: ClankerStepState | null;
}

interface ClankerWaveGroup {
  readonly wave: number | null;
  readonly rows: ReadonlyArray<ClankerStepRow>;
}

/**
 * Orders a run's steps the way the workflow executes them. Steps the workflow
 * dropped since the run started keep their recorded state but fall into a
 * trailing `null` wave rather than disappearing.
 */
export function clankerStepRows(
  steps: Readonly<Record<string, ClankerStepState>>,
  waves: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ClankerStepRow> {
  const placed = new Set<string>();
  const rows: ClankerStepRow[] = [];
  waves.forEach((wave, index) => {
    for (const stepName of wave) {
      if (placed.has(stepName)) continue;
      placed.add(stepName);
      rows.push({ stepName, wave: index + 1, state: steps[stepName] ?? null });
    }
  });
  for (const [stepName, state] of Object.entries(steps)) {
    if (placed.has(stepName)) continue;
    rows.push({ stepName, wave: null, state });
  }
  return rows;
}

export function clankerWaveGroups(
  rows: ReadonlyArray<ClankerStepRow>,
): ReadonlyArray<ClankerWaveGroup> {
  const groups: ClankerWaveGroup[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last !== undefined && last.wave === row.wave) {
      groups[groups.length - 1] = { wave: last.wave, rows: [...last.rows, row] };
      continue;
    }
    groups.push({ wave: row.wave, rows: [row] });
  }
  return groups;
}

interface ClankerRunProgress {
  /** Steps that reached a terminal status. */
  readonly settled: number;
  readonly total: number;
  /** 0-100, rounded. */
  readonly percent: number;
}

export function clankerRunProgress(summary: {
  readonly stepTotal: number;
  readonly passedSteps: number;
  readonly failedSteps: number;
}): ClankerRunProgress {
  const total = Math.max(0, summary.stepTotal);
  const settled = Math.min(total, Math.max(0, summary.passedSteps + summary.failedSteps));
  return {
    settled,
    total,
    percent: total === 0 ? 0 : Math.round((settled / total) * 100),
  };
}

/** A duration's bounds; `endedAt` is null while the work is still in flight. */
export interface ClankerDurationRange {
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/**
 * A run measures from its start to its last transition, and stays open while
 * it runs so the label keeps counting.
 */
export function clankerRunDurationRange(run: {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: ClankerRunStatus;
}): ClankerDurationRange {
  return {
    startedAt: run.startedAt,
    endedAt: run.status === "running" ? null : run.updatedAt,
  };
}

/**
 * Null when there is no duration to show: the step never started, or it
 * settled without the runner recording when.
 */
export function clankerStepDurationRange(state: ClankerStepState): ClankerDurationRange | null {
  if (state.startedAt === undefined) return null;
  if (state.status === "running") return { startedAt: state.startedAt, endedAt: null };
  if (state.completedAt === undefined) return null;
  return { startedAt: state.startedAt, endedAt: state.completedAt };
}

export function formatClankerDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/**
 * Agent responses routinely run to tens of kilobytes. Rendering one whole
 * costs more layout than it is worth, so a card shows a bounded head and says
 * how much it left out.
 */
const CLANKER_RESPONSE_PREVIEW_CHARS = 2_000;

interface ClankerClampedText {
  readonly text: string;
  readonly hiddenChars: number;
}

export function clampClankerText(
  value: string,
  maxChars = CLANKER_RESPONSE_PREVIEW_CHARS,
): ClankerClampedText {
  if (value.length <= maxChars) return { text: value, hiddenChars: 0 };
  return { text: value.slice(0, maxChars), hiddenChars: value.length - maxChars };
}

export const CLANKER_STEP_STATUS_LABEL: Record<ClankerStepStatus, string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

export const CLANKER_RUN_STATUS_LABEL: Record<ClankerRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A cancelled or failed run can be resumed; a completed or in-flight one cannot. */
export function clankerRunIsResumable(status: ClankerRunStatus): boolean {
  return status === "failed" || status === "cancelled";
}

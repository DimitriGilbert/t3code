// TEST FIXTURE ONLY — never shipped. Minimal pack widget for journey-5 e2e:
// subscribes to the bound instance's snapshot stream and renders clanker runs.

interface ClankerRun {
  runId: string;
  workflowName: string | null;
  status: string;
  currentStep: string | null;
  stepsCompleted: number;
  steps: Array<{ name: string; status: string; retryCount: number }>;
}

declare const T3: {
  h: (
    type: string | Function,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) => Node;
  Fragment: (props: { children?: unknown[] }) => unknown;
  render: (component: () => Node | null) => void;
  subscribe: (
    name: string,
    onData: (data: unknown) => void,
    onError?: (error: unknown) => void,
  ) => () => void;
};

let runs: ClankerRun[] = [];
let lastError: string | null = null;
let waiting = true;

const snapshotRuns = (item: unknown): ClankerRun[] => {
  const snapshot = (item as { type?: string; snapshot?: { data?: { runs?: ClankerRun[] } } })
    ?.snapshot;
  const runs = snapshot?.data?.runs;
  return Array.isArray(runs) ? runs : [];
};

const view = () =>
  (
    <div style="font:12px/1.4 monospace;padding:8px">
      {waiting ? <div>Awaiting clanker data…</div> : null}
      {lastError !== null ? <div>Error: {lastError}</div> : null}
      {runs.map((run) => (
        <div key={run.runId} style="display:flex;gap:8px;padding:2px 0">
          <span>{run.runId}</span>
          <span>{run.status}</span>
          <span>
            {run.currentStep ?? "—"} ({run.stepsCompleted}/{run.steps.length})
          </span>
        </div>
      ))}
    </div>
  ) as unknown as Node;

T3.subscribe(
  "runs",
  (data) => {
    waiting = false;
    runs = snapshotRuns(data);
    T3.render(view);
  },
  (error) => {
    waiting = false;
    lastError = error instanceof Error ? error.message : String(error);
    T3.render(view);
  },
);
T3.render(view);

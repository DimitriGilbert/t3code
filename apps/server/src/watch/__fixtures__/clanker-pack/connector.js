// TEST FIXTURE ONLY — never shipped. Minimal file-transport connector pack
// emulating the Clanker watch shape for watch-screen tests (journey 5): the
// poller hands it the collected contents under the instance's allowlisted
// roots (never raw paths or reads of its own), and it folds every

const RUN_STATE_RE = /(^|\/)runs\/([^/]+)\/state\.json$/;
const RUN_RESULT_RE = /(^|\/)runs\/([^/]+)\/result\.json$/;

const readJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

module.exports = {
  transform: (raw) => {
    const runs = new Map();
    // `raw` is the collected file map keyed `<rootName>/<relative path>`.
    for (const [key, text] of Object.entries(raw)) {
      const stateMatch = RUN_STATE_RE.exec(key);
      if (stateMatch) {
        const state = readJson(text);
        if (state === undefined || typeof state !== "object") continue;
        const steps = Object.entries(state.steps ?? {}).map(([name, step]) => ({
          name,
          status: step.status ?? "pending",
          retryCount: step.retryCount ?? 0,
        }));
        const current = steps.find((step) => step.status === "running");
        // File-map order is walk order — a result.json collected first must
        // not be clobbered by the state.json entry that follows it.
        const existing = runs.get(stateMatch[2]);
        runs.set(stateMatch[2], {
          runId: state.runId ?? stateMatch[2],
          workflowName: state.workflowName ?? null,
          status: state.status ?? "unknown",
          currentStep: current === undefined ? null : current.name,
          stepsCompleted: steps.filter(
            (step) => step.status === "passed" || step.status === "skipped",
          ).length,
          steps,
          startedAt: state.startedAt ?? null,
          updatedAt: state.updatedAt ?? null,
          result: existing === undefined ? null : existing.result,
        });
        continue;
      }
      const resultMatch = RUN_RESULT_RE.exec(key);
      if (resultMatch) {
        const result = readJson(text);
        const entry = runs.get(resultMatch[2]) ?? {
          runId: resultMatch[2],
          workflowName: null,
          status: "unknown",
          currentStep: null,
          stepsCompleted: 0,
          steps: [],
          startedAt: null,
          updatedAt: null,
        };
        runs.set(resultMatch[2], {
          ...entry,
          result: result === undefined ? null : result,
        });
      }
    }
    return {
      kind: "clanker-runs",
      runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
    };
  },
};

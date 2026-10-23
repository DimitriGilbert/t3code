(() => {
  // widget.tsx
  var runs = [];
  var lastError = null;
  var waiting = true;
  var snapshotRuns = (item) => {
    const snapshot = item?.snapshot;
    const runs2 = snapshot?.data?.runs;
    return Array.isArray(runs2) ? runs2 : [];
  };
  var view = () =>
    /* @__PURE__ */ T3.h(
      "div",
      { style: "font:12px/1.4 monospace;padding:8px" },
      waiting ? /* @__PURE__ */ T3.h("div", null, "Awaiting clanker data…") : null,
      lastError !== null ? /* @__PURE__ */ T3.h("div", null, "Error: ", lastError) : null,
      runs.map((run) =>
        /* @__PURE__ */ T3.h(
          "div",
          { key: run.runId, style: "display:flex;gap:8px;padding:2px 0" },
          /* @__PURE__ */ T3.h("span", null, run.runId),
          /* @__PURE__ */ T3.h("span", null, run.status),
          /* @__PURE__ */ T3.h(
            "span",
            null,
            run.currentStep ?? "—",
            " (",
            run.stepsCompleted,
            "/",
            run.steps.length,
            ")",
          ),
        ),
      ),
    );
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
})();

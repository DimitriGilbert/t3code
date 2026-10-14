#!/usr/bin/env node
// TEST FIXTURE ONLY — never shipped. Stands in for `clanker run --no-ai` in
// watch-screen tests (the real CLI is not on PATH in the test environment):
// it emits `<projectDir>/.clanker/runs/<runId>/state.json` in Clanker's
// PersistedRunState shape — rewritten on every step transition like the real
// runner — and `result.json` when the run ends. A file-transport connector
// instance watching `<projectDir>/.clanker` picks the writes up through the
// normal watch path.
//
// Usage:
//   node stub-clanker.mjs <projectDir> [--run-id <id>] [--workflow <name>]
//       [--steps a,b,c] [--step-delay-ms <ms>] [--fail-at <step>]
//
//   --run-id         run directory name (default: run-<unix ms>)
//   --workflow       workflow name recorded on the state file (default: fixture-flow)
//   --steps          comma-separated step names (default: plan,build,verify)
//   --step-delay-ms  delay between step transitions (default: 0 — write
//                    immediately; the watch path debounces bursts)
//   --fail-at        mark the named step failed and end the run as failed
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const projectDir = args[0];
if (projectDir === undefined || projectDir.startsWith("--")) {
  process.stderr.write("usage: stub-clanker.mjs <projectDir> [options]\n");
  process.exit(2);
}

const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const runId = option("--run-id", `run-${Date.now()}`);
const workflowName = option("--workflow", "fixture-flow");
const steps = (option("--steps", "plan,build,verify") ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const stepDelayMs = Number(option("--step-delay-ms", "0"));
const failAt = option("--fail-at", undefined);

const runDir = NodePath.join(projectDir, ".clanker", "runs", runId);
NodeFS.mkdirSync(runDir, { recursive: true });

const state = {
  runId,
  workflowName,
  workflowPath: `${workflowName}.yaml`,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "running",
  steps: Object.fromEntries(steps.map((name) => [name, { status: "pending", retryCount: 0 }])),
};

const writeState = () => {
  state.updatedAt = new Date().toISOString();
  // Atomic-ish write like the real runner: temp file, then rename.
  const tmp = NodePath.join(runDir, `state.${process.pid}.tmp`);
  NodeFS.writeFileSync(tmp, JSON.stringify(state, null, 2));
  NodeFS.renameSync(tmp, NodePath.join(runDir, "state.json"));
};

const delay = () =>
  stepDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, stepDelayMs)) : Promise.resolve();

writeState();
for (const name of steps) {
  state.steps[name].status = "running";
  state.steps[name].startedAt = new Date().toISOString();
  writeState();
  await delay();
  if (name === failAt) {
    state.steps[name].status = "failed";
    state.steps[name].error = "stub-clanker: step failed on request";
    state.steps[name].completedAt = new Date().toISOString();
    state.status = "failed";
    break;
  }
  state.steps[name].status = "passed";
  state.steps[name].completedAt = new Date().toISOString();
  writeState();
  await delay();
}
if (state.status === "running") state.status = "completed";
writeState();
NodeFS.writeFileSync(
  NodePath.join(runDir, "result.json"),
  JSON.stringify(
    {
      runId,
      success: state.status === "completed",
      cancelled: false,
      name: workflowName,
      steps: Object.entries(state.steps).map(([stepName, step]) => ({
        stepName,
        success: step.status === "passed",
        skipped: step.status === "skipped",
        durationMs: 0,
        responses: [],
        outputs: {},
        error: step.error ?? null,
        retryCount: step.retryCount,
      })),
    },
    null,
    2,
  ),
);
process.stdout.write(`${runId}\n`);

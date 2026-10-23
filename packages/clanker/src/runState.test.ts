import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ClankerPersistedRunState, ClankerRunResult } from "./runState.ts";

// Copied verbatim from the Clanker repo:
// apps/cli/.clanker/runs/ffe33dc0-1af2-4736-894e-2dc0bb818654/state.json
const COMPLETED_STATE = `{
  "runId": "ffe33dc0-1af2-4736-894e-2dc0bb818654",
  "workflowName": "minimal",
  "workflowPath": "/home/didi/workspace/Clanker/apps/cli/tests/fixtures/minimal.yaml",
  "startedAt": "2026-08-21T17:02:32.380Z",
  "updatedAt": "2026-08-21T17:02:32.383Z",
  "status": "completed",
  "steps": {
    "greet": {
      "status": "passed",
      "retryCount": 0,
      "responses": [
        {
          "prompt_index": 0,
          "model_id": "default",
          "response": "ok"
        }
      ],
      "declaredOutputs": {},
      "outputs": {},
      "startedAt": "2026-08-21T17:02:32.381Z",
      "completedAt": "2026-08-21T17:02:32.381Z"
    }
  }
}`;

// Copied verbatim from the Clanker repo:
// apps/cli/.clanker/runs/07153129-49f6-494c-803e-ef66531a2ceb/state.json
const FAILED_STATE = `{
  "runId": "07153129-49f6-494c-803e-ef66531a2ceb",
  "workflowName": "minimal",
  "workflowPath": "/home/didi/workspace/Clanker/apps/cli/tests/fixtures/minimal.yaml",
  "startedAt": "2026-08-21T17:13:24.763Z",
  "updatedAt": "2026-08-21T17:13:24.775Z",
  "status": "failed",
  "steps": {
    "greet": {
      "status": "failed",
      "retryCount": 0,
      "responses": [],
      "declaredOutputs": {},
      "outputs": {},
      "startedAt": "2026-08-21T17:13:24.766Z",
      "completedAt": "2026-08-21T17:13:24.766Z",
      "error": "executor exploded"
    }
  }
}`;

// Copied verbatim from the Clanker repo:
// apps/cli/.clanker/runs/ffe33dc0-1af2-4736-894e-2dc0bb818654/result.json
const COMPLETED_RESULT = `{
  "runId": "ffe33dc0-1af2-4736-894e-2dc0bb818654",
  "success": true,
  "cancelled": false,
  "name": "minimal",
  "steps": [
    {
      "stepName": "greet",
      "success": true,
      "skipped": false,
      "durationMs": 0,
      "responses": [
        {
          "prompt_index": 0,
          "model_id": "default",
          "response": "ok"
        }
      ],
      "declaredOutputs": {},
      "outputs": {},
      "retryCount": 0
    }
  ]
}`;

const decodeState = Schema.decodeUnknownSync(ClankerPersistedRunState);
const decodeResult = Schema.decodeUnknownSync(ClankerRunResult);

describe("ClankerPersistedRunState", () => {
  it("decodes a real completed state.json", () => {
    const state = decodeState(JSON.parse(COMPLETED_STATE));
    expect(state.runId).toBe("ffe33dc0-1af2-4736-894e-2dc0bb818654");
    expect(state.status).toBe("completed");
    expect(state.steps["greet"]?.status).toBe("passed");
    expect(state.steps["greet"]?.responses).toHaveLength(1);
  });

  it("decodes a real failed state.json with an error", () => {
    const state = decodeState(JSON.parse(FAILED_STATE));
    expect(state.status).toBe("failed");
    expect(state.steps["greet"]?.error).toBe("executor exploded");
  });

  it("encodes back to the persisted shape", () => {
    const decoded = decodeState(JSON.parse(COMPLETED_STATE));
    const encoded = Schema.encodeSync(ClankerPersistedRunState)(decoded);
    expect(encoded).toEqual(JSON.parse(COMPLETED_STATE));
  });

  it("rejects an unknown status", () => {
    const raw = JSON.parse(FAILED_STATE) as { status: string };
    raw.status = "exploded";
    expect(() => decodeState(raw)).toThrow();
  });
});

describe("ClankerRunResult", () => {
  it("decodes a real result.json", () => {
    const result = decodeResult(JSON.parse(COMPLETED_RESULT));
    expect(result.success).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.steps[0]?.stepName).toBe("greet");
    expect(result.steps[0]?.retryCount).toBe(0);
  });
});

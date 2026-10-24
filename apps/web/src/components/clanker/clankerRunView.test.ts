import type { ClankerStepState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampClankerText,
  clankerRunDurationRange,
  clankerRunProgress,
  clankerStepDurationRange,
  clankerStepRows,
  clankerWaveGroups,
  formatClankerDuration,
} from "./clankerRunView";

function step(overrides: Partial<ClankerStepState> = {}): ClankerStepState {
  return {
    status: "pending",
    retryCount: 0,
    responses: [],
    declaredOutputs: {},
    outputs: {},
    ...overrides,
  };
}

describe("clankerStepRows", () => {
  it("orders steps by wave and keeps steps the workflow no longer declares", () => {
    const rows = clankerStepRows(
      {
        build: step({ status: "passed" }),
        test: step({ status: "running" }),
        retired: step({ status: "failed" }),
      },
      [["build"], ["test", "lint"]],
    );

    expect(rows).toEqual([
      { stepName: "build", wave: 1, state: expect.objectContaining({ status: "passed" }) },
      { stepName: "test", wave: 2, state: expect.objectContaining({ status: "running" }) },
      { stepName: "lint", wave: 2, state: null },
      { stepName: "retired", wave: null, state: expect.objectContaining({ status: "failed" }) },
    ]);
  });

  it("falls back to recorded order when the workflow has no waves", () => {
    const rows = clankerStepRows({ a: step(), b: step() }, []);
    expect(rows.map((row) => [row.stepName, row.wave])).toEqual([
      ["a", null],
      ["b", null],
    ]);
  });

  it("groups consecutive rows of the same wave", () => {
    const groups = clankerWaveGroups(
      clankerStepRows({ a: step(), b: step(), c: step() }, [["a"], ["b", "c"]]),
    );
    expect(groups.map((group) => [group.wave, group.rows.length])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("clankerRunProgress", () => {
  it("counts settled steps and clamps to the total", () => {
    expect(clankerRunProgress({ stepTotal: 7, passedSteps: 3, failedSteps: 1 })).toEqual({
      settled: 4,
      total: 7,
      percent: 57,
    });
    expect(clankerRunProgress({ stepTotal: 2, passedSteps: 3, failedSteps: 1 }).settled).toBe(2);
  });

  it("reports zero percent for an empty workflow instead of dividing by zero", () => {
    expect(clankerRunProgress({ stepTotal: 0, passedSteps: 0, failedSteps: 0 }).percent).toBe(0);
  });
});

describe("clankerRunDurationRange", () => {
  const startedAt = "2024-05-01T10:00:00.000Z";

  it("leaves a running run open so its label keeps counting", () => {
    expect(clankerRunDurationRange({ startedAt, updatedAt: startedAt, status: "running" })).toEqual(
      { startedAt, endedAt: null },
    );
  });

  it("closes a settled run at its last transition", () => {
    expect(
      clankerRunDurationRange({
        startedAt,
        updatedAt: "2024-05-01T10:01:00.000Z",
        status: "failed",
      }),
    ).toEqual({ startedAt, endedAt: "2024-05-01T10:01:00.000Z" });
  });
});

describe("clankerStepDurationRange", () => {
  it("is null until the step starts", () => {
    expect(clankerStepDurationRange(step())).toBeNull();
  });

  it("is null for a step that settled without a completion time", () => {
    expect(
      clankerStepDurationRange(step({ status: "failed", startedAt: "2024-05-01T10:00:00.000Z" })),
    ).toBeNull();
  });

  it("closes a finished step on its own timestamps", () => {
    expect(
      clankerStepDurationRange(
        step({
          status: "passed",
          startedAt: "2024-05-01T10:00:00.000Z",
          completedAt: "2024-05-01T10:00:09.000Z",
        }),
      ),
    ).toEqual({ startedAt: "2024-05-01T10:00:00.000Z", endedAt: "2024-05-01T10:00:09.000Z" });
  });

  it("leaves a running step open even when a prior attempt recorded a completion", () => {
    expect(
      clankerStepDurationRange(
        step({
          status: "running",
          startedAt: "2024-05-01T10:00:00.000Z",
          completedAt: "2024-05-01T10:00:09.000Z",
        }),
      ),
    ).toEqual({ startedAt: "2024-05-01T10:00:00.000Z", endedAt: null });
  });
});

describe("formatClankerDuration", () => {
  it("steps up units and drops empty remainders", () => {
    expect(formatClankerDuration(0)).toBe("0s");
    expect(formatClankerDuration(45_000)).toBe("45s");
    expect(formatClankerDuration(90_000)).toBe("1m 30s");
    expect(formatClankerDuration(120_000)).toBe("2m");
    expect(formatClankerDuration(3_600_000)).toBe("1h");
    expect(formatClankerDuration(3_900_000)).toBe("1h 5m");
    expect(formatClankerDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("clampClankerText", () => {
  it("reports how much of a long response it withheld", () => {
    expect(clampClankerText("abcdef", 4)).toEqual({ text: "abcd", hiddenChars: 2 });
    expect(clampClankerText("abc", 4)).toEqual({ text: "abc", hiddenChars: 0 });
  });
});

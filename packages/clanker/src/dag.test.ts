import { describe, expect, it } from "vite-plus/test";

import { buildClankerWaves } from "./dag.ts";
import type { ClankerStep } from "./format.ts";

const step = (
  name: string,
  depends_on?: ReadonlyArray<string>,
): Pick<ClankerStep, "name" | "depends_on"> => ({
  name,
  ...(depends_on === undefined ? {} : { depends_on }),
});

describe("buildClankerWaves", () => {
  it("puts independent steps in one wave", () => {
    const { waves, diagnostics } = buildClankerWaves([step("a"), step("b"), step("c")]);
    expect(waves).toEqual([["a", "b", "c"]]);
    expect(diagnostics).toEqual([]);
  });

  it("orders a linear chain", () => {
    const { waves } = buildClankerWaves([step("a"), step("b", ["a"]), step("c", ["b"])]);
    expect(waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("fans in shared dependencies", () => {
    const { waves } = buildClankerWaves([
      step("a"),
      step("b", ["a"]),
      step("c", ["a"]),
      step("d", ["b", "c"]),
    ]);
    expect(waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("handles a diamond", () => {
    const { waves } = buildClankerWaves([
      step("root"),
      step("left", ["root"]),
      step("right", ["root"]),
      step("join", ["left", "right"]),
    ]);
    expect(waves).toEqual([["root"], ["left", "right"], ["join"]]);
  });

  it("reports a missing depends_on target but still schedules", () => {
    const { waves, diagnostics } = buildClankerWaves([step("a", ["ghost"]), step("b", ["a"])]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        path: "steps[0].depends_on",
      }),
    ]);
    expect(waves).toEqual([["a"], ["b"]]);
  });

  it("reports cycle members and keeps the acyclic prefix", () => {
    const { waves, diagnostics } = buildClankerWaves([
      step("seed"),
      step("x", ["seed", "z"]),
      step("y", ["x"]),
      step("z", ["y"]),
    ]);
    expect(waves).toEqual([["seed"]]);
    const cycle = diagnostics.find((d) => d.message.includes("Circular dependency"));
    expect(cycle?.severity).toBe("error");
    expect(cycle?.path).toBe("steps[1].depends_on");
    expect(cycle?.message).toContain("x");
    expect(cycle?.message).toContain("z");
  });

  it("reports a self-cycle", () => {
    const { diagnostics } = buildClankerWaves([step("a", ["a"])]);
    expect(diagnostics.some((d) => d.message.includes("a -> a"))).toBe(true);
  });

  it("reports duplicate step names", () => {
    const { diagnostics } = buildClankerWaves([step("a"), step("a")]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: "error", path: "steps[1].name" }),
    ]);
  });
});

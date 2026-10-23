/**
 * Topological "wave" computation for Clanker steps — Kahn's algorithm over
 * `depends_on`, matching Clanker's `dag.ts`. Missing targets, duplicate
 * names, and cycles surface as diagnostics instead of aborting the whole
 * build: the acyclic prefix still produces waves for display.
 */
import type { ClankerStep } from "./format.ts";
import type { ClankerDiagnostic } from "./parse.ts";

export interface ClankerWavesResult {
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  readonly diagnostics: ReadonlyArray<ClankerDiagnostic>;
}

type StepLike = Pick<ClankerStep, "name" | "depends_on">;

export function buildClankerWaves(steps: ReadonlyArray<StepLike>): ClankerWavesResult {
  const diagnostics: ClankerDiagnostic[] = [];

  // First occurrence wins; later duplicates are flagged and left unscheduled.
  const indexByName = new Map<string, number>();
  const uniqueSteps: StepLike[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    if (indexByName.has(step.name)) {
      diagnostics.push({
        severity: "error",
        message: `Duplicate step name: "${step.name}"`,
        path: `steps[${i}].name`,
      });
      continue;
    }
    indexByName.set(step.name, i);
    uniqueSteps.push(step);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of uniqueSteps) {
    inDegree.set(step.name, 0);
    dependents.set(step.name, []);
  }

  for (const step of uniqueSteps) {
    for (const dep of step.depends_on ?? []) {
      if (!inDegree.has(dep)) {
        diagnostics.push({
          severity: "error",
          message: `Step "${dep}" referenced in depends_on does not exist`,
          path: `steps[${indexByName.get(step.name) ?? 0}].depends_on`,
        });
        continue;
      }
      inDegree.set(step.name, (inDegree.get(step.name) ?? 0) + 1);
      dependents.get(dep)?.push(step.name);
    }
  }

  const waves: string[][] = [];
  const remaining = new Set(uniqueSteps.map((step) => step.name));
  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const name of remaining) {
      if ((inDegree.get(name) ?? 0) === 0) {
        wave.push(name);
      }
    }
    if (wave.length === 0) {
      break;
    }
    waves.push(wave);
    for (const name of wave) {
      remaining.delete(name);
      for (const dependent of dependents.get(name) ?? []) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
      }
    }
  }

  if (remaining.size > 0) {
    for (const cycle of findCycles(uniqueSteps)) {
      diagnostics.push({
        severity: "error",
        message: `Circular dependency detected: ${cycle.join(" -> ")} -> ${cycle[0] ?? ""}`,
        path: `steps[${indexByName.get(cycle[0] ?? "") ?? 0}].depends_on`,
      });
    }
  }

  return { waves, diagnostics };
}

/**
 * DFS over surviving `depends_on` edges, reporting each distinct cycle once
 * (deduped by member set), mirroring Clanker's validator.
 */
function findCycles(steps: ReadonlyArray<StepLike>): string[][] {
  const names = new Set(steps.map((step) => step.name));
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    adjacency.set(
      step.name,
      (step.depends_on ?? []).filter((dep) => names.has(dep)),
    );
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const name of names) {
    color.set(name, WHITE);
  }

  const seen = new Set<string>();
  const cycles: string[][] = [];

  const visit = (node: string, path: string[]): void => {
    color.set(node, GRAY);
    path.push(node);
    for (const dep of adjacency.get(node) ?? []) {
      if (color.get(dep) === GRAY) {
        const cycle = path.slice(path.indexOf(dep));
        const key = [...cycle].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(dep) === WHITE) {
        visit(dep, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  };

  for (const name of names) {
    if (color.get(name) === WHITE) {
      visit(name, []);
    }
  }
  return cycles;
}

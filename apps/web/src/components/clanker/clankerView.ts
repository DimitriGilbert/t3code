import type {
  ClankerDiagnosticSeverity,
  EnvironmentId,
  ScopedProjectRef,
} from "@t3tools/contracts";

export interface ClankerProjectOption {
  readonly key: string;
  readonly ref: ScopedProjectRef;
  readonly label: string;
  readonly environmentId: EnvironmentId;
}

/** Server-side slugification for `clanker.workflows.create` (ClankerWorkflowService). */
export function clankerWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function clankerWorkflowNameError(name: string): string | null {
  if (name.trim().length === 0) return "Name the workflow.";
  if (clankerWorkflowSlug(name).length === 0) return "The name needs at least one letter or digit.";
  return null;
}

export const CLANKER_SEVERITY_ICON_CLASS: Record<ClankerDiagnosticSeverity, string> = {
  error: "text-destructive",
  warning: "text-warning",
  unsupported: "text-warning",
};

export function clankerWorkflowFileName(path: string): string {
  const segment = path.split("/").pop();
  return segment ?? path;
}

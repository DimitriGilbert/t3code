import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Project-relative path to a `.yml`/`.yaml`/`.json` clanker workflow file. */
export const ClankerWorkflowPath = TrimmedNonEmptyString.pipe(Schema.brand("ClankerWorkflowPath"));
export type ClankerWorkflowPath = typeof ClankerWorkflowPath.Type;

export const ClankerDiagnosticSeverity = Schema.Literals(["error", "warning", "unsupported"]);
export type ClankerDiagnosticSeverity = typeof ClankerDiagnosticSeverity.Type;

export const ClankerDiagnostic = Schema.Struct({
  severity: ClankerDiagnosticSeverity,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});
export type ClankerDiagnostic = typeof ClankerDiagnostic.Type;

export const ClankerWorkflowSummary = Schema.Struct({
  path: ClankerWorkflowPath,
  name: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  stepCount: NonNegativeInt,
  modifiedAt: Schema.NullOr(IsoDateTime),
  /** Count of diagnostics with severity "error" or "unsupported". */
  issueCount: NonNegativeInt,
});
export type ClankerWorkflowSummary = typeof ClankerWorkflowSummary.Type;

export const ClankerWorkflowDocument = Schema.Struct({
  path: ClankerWorkflowPath,
  content: Schema.String,
  diagnostics: ForwardCompatibleArray(ClankerDiagnostic),
  waves: Schema.Array(Schema.Array(Schema.String)),
});
export type ClankerWorkflowDocument = typeof ClankerWorkflowDocument.Type;

export class ClankerWorkflowNotFoundError extends Schema.TaggedError<ClankerWorkflowNotFoundError>()(
  "ClankerWorkflowNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Clanker workflow '${this.path}' does not exist.`;
  }
}

export class ClankerWorkflowOutsideRootError extends Schema.TaggedError<ClankerWorkflowOutsideRootError>()(
  "ClankerWorkflowOutsideRootError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Clanker workflow path '${this.path}' resolves outside the project root.`;
  }
}

export class ClankerWorkflowInvalidNameError extends Schema.TaggedError<ClankerWorkflowInvalidNameError>()(
  "ClankerWorkflowInvalidNameError",
  { name: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid clanker workflow name '${this.name}': ${this.detail}.`;
  }
}

export class ClankerWorkflowReadError extends Schema.TaggedError<ClankerWorkflowReadError>()(
  "ClankerWorkflowReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read clanker workflow '${this.path}'.`;
  }
}

export class ClankerWorkflowWriteError extends Schema.TaggedError<ClankerWorkflowWriteError>()(
  "ClankerWorkflowWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to write clanker workflow '${this.path}'.`;
  }
}

export const ClankerWorkflowError = Schema.Union([
  ClankerWorkflowNotFoundError,
  ClankerWorkflowOutsideRootError,
  ClankerWorkflowInvalidNameError,
  ClankerWorkflowReadError,
  ClankerWorkflowWriteError,
]);
export type ClankerWorkflowError = typeof ClankerWorkflowError.Type;

export const ClankerWorkflowListInput = Schema.Struct({
  projectId: ProjectId,
});
export type ClankerWorkflowListInput = typeof ClankerWorkflowListInput.Type;

export const ClankerWorkflowListResult = Schema.Struct({
  workflows: Schema.Array(ClankerWorkflowSummary),
});
export type ClankerWorkflowListResult = typeof ClankerWorkflowListResult.Type;

export const ClankerWorkflowGetInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
});
export type ClankerWorkflowGetInput = typeof ClankerWorkflowGetInput.Type;

export const ClankerWorkflowCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  content: Schema.optional(Schema.String),
});
export type ClankerWorkflowCreateInput = typeof ClankerWorkflowCreateInput.Type;

export const ClankerWorkflowUpdateInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
  content: Schema.String,
});
export type ClankerWorkflowUpdateInput = typeof ClankerWorkflowUpdateInput.Type;

export const ClankerWorkflowDeleteInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
});
export type ClankerWorkflowDeleteInput = typeof ClankerWorkflowDeleteInput.Type;

export const ClankerWorkflowValidateInput = Schema.Struct({
  projectId: ProjectId,
  content: Schema.String,
});
export type ClankerWorkflowValidateInput = typeof ClankerWorkflowValidateInput.Type;

export const ClankerWorkflowValidateResult = Schema.Struct({
  diagnostics: ForwardCompatibleArray(ClankerDiagnostic),
});
export type ClankerWorkflowValidateResult = typeof ClankerWorkflowValidateResult.Type;

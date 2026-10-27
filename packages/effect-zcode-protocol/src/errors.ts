import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

const ZCodeAppServerRequestOperation = Schema.Literals([
  "decode-payload",
  "encode-payload",
  "handle-request",
  "receive-response",
]);
type ZCodeAppServerRequestOperation = typeof ZCodeAppServerRequestOperation.Type;

const ZCodeAppServerSchemaIssueKind = Schema.Literals([
  "Filter",
  "Encoding",
  "Pointer",
  "Composite",
  "AnyOf",
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);
type ZCodeAppServerSchemaIssueKind = typeof ZCodeAppServerSchemaIssueKind.Type;

interface ZCodeAppServerSchemaIssueDiagnostics {
  readonly issueCount: number;
  readonly issueKinds: ReadonlyArray<ZCodeAppServerSchemaIssueKind>;
  readonly maximumPathDepth: number;
}

const schemaIssueDiagnostics = (root: SchemaIssue.Issue): ZCodeAppServerSchemaIssueDiagnostics => {
  let issueCount = 0;
  let maximumPathDepth = 0;
  const issueKinds = new Set<ZCodeAppServerSchemaIssueKind>();

  const visit = (issue: SchemaIssue.Issue, pathDepth: number): void => {
    issueCount += 1;
    issueKinds.add(issue._tag);
    maximumPathDepth = Math.max(maximumPathDepth, pathDepth);
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        visit(issue.issue, pathDepth);
        break;
      case "Pointer":
        visit(issue.issue, pathDepth + issue.path.length);
        break;
      case "Composite":
      case "AnyOf":
        for (const child of issue.issues) visit(child, pathDepth);
        break;
    }
  };

  visit(root, 0);
  return {
    issueCount,
    issueKinds: [...issueKinds],
    maximumPathDepth,
  };
};

const ZCodeAppServerPayloadKind = Schema.Literals([
  "null",
  "array",
  "string",
  "number",
  "boolean",
  "bigint",
  "object",
  "symbol",
  "function",
  "undefined",
]);
type ZCodeAppServerPayloadKind = typeof ZCodeAppServerPayloadKind.Type;

const payloadKind = (payload: unknown): ZCodeAppServerPayloadKind => {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  return typeof payload;
};

const protocolMessageFields = ["id", "method", "params", "result", "error"] as const;

const ZCodeAppServerProtocolMessageField = Schema.Literals(protocolMessageFields);

export interface ZCodeAppServerRequestDiagnostics {
  readonly method?: string;
  readonly requestId?: string;
  readonly operation?: ZCodeAppServerRequestOperation;
  readonly cause?: unknown;
  readonly issueCount?: number;
  readonly issueKinds?: ReadonlyArray<ZCodeAppServerSchemaIssueKind>;
  readonly maximumPathDepth?: number;
  readonly payloadKind?: ZCodeAppServerPayloadKind;
}

export const ZCodeAppServerProtocolParseOperation = Schema.Literals([
  "encode-wire-message",
  "decode-wire-message",
  "route-wire-message",
  "decode-notification-payload",
  "decode-request-payload",
  "decode-response-payload",
]);
export type ZCodeAppServerProtocolParseOperation = typeof ZCodeAppServerProtocolParseOperation.Type;

export const ZCodeAppServerTransportOperation = Schema.Literals([
  "read-input-stream",
  "read-process-exit-status",
]);
export type ZCodeAppServerTransportOperation = typeof ZCodeAppServerTransportOperation.Type;

// Vocabulary of database-startup.ts's DatabaseStartupErrorCode.
export const ZCodeStorageStartupErrorCode = Schema.Literals([
  "storage_full",
  "permission_denied",
  "io_error",
  "out_of_memory",
  "corrupt",
  "open_failed",
  "lock_timeout",
  "checksum_mismatch",
  "sql_failed",
  "startup_status_timeout",
  "transport_closed",
  "unsupported_runtime",
]);
export type ZCodeStorageStartupErrorCode = typeof ZCodeStorageStartupErrorCode.Type;

export interface ZCodeAppServerProtocolErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class ZCodeAppServerSpawnError extends Schema.TaggedError<ZCodeAppServerSpawnError>()(
  "ZCodeAppServerSpawnError",
  {
    command: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.command
      ? `Failed to spawn ZCode app-server process for command: ${this.command}`
      : "Failed to spawn ZCode app-server process";
  }
}

export class ZCodeAppServerProcessExitedError extends Schema.TaggedError<ZCodeAppServerProcessExitedError>()(
  "ZCodeAppServerProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.code === undefined
      ? "ZCode app-server process exited"
      : `ZCode app-server process exited with code ${this.code}`;
  }
}

export class ZCodeAppServerProtocolParseError extends Schema.TaggedError<ZCodeAppServerProtocolParseError>()(
  "ZCodeAppServerProtocolParseError",
  {
    operation: ZCodeAppServerProtocolParseOperation,
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    payloadKind: Schema.optionalKey(ZCodeAppServerPayloadKind),
    presentFields: Schema.optionalKey(Schema.Array(ZCodeAppServerProtocolMessageField)),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(ZCodeAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    return `ZCode app-server protocol operation '${this.operation}' failed${method}.`;
  }

  static fromSchemaError(
    operation: ZCodeAppServerProtocolParseOperation,
    cause: Schema.SchemaError,
    context: { readonly method?: string; readonly requestId?: string } = {},
  ) {
    return new ZCodeAppServerProtocolParseError({
      operation,
      ...context,
      ...schemaIssueDiagnostics(cause.issue),
      cause,
    });
  }

  static fromRequestError(
    operation: ZCodeAppServerProtocolParseOperation,
    method: string,
    cause: ZCodeAppServerRequestError,
  ) {
    return new ZCodeAppServerProtocolParseError({
      operation,
      method,
      ...(cause.issueCount === undefined ? {} : { issueCount: cause.issueCount }),
      ...(cause.issueKinds === undefined ? {} : { issueKinds: cause.issueKinds }),
      ...(cause.maximumPathDepth === undefined ? {} : { maximumPathDepth: cause.maximumPathDepth }),
      cause,
    });
  }

  static fromUnroutableMessage(message: unknown) {
    const diagnostics = { payloadKind: payloadKind(message) };
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return new ZCodeAppServerProtocolParseError({
        operation: "route-wire-message",
        ...diagnostics,
      });
    }

    const presentFields = protocolMessageFields.filter((field) => field in message);
    const method =
      "method" in message && typeof message.method === "string" ? message.method : undefined;
    const requestId =
      "id" in message && (typeof message.id === "string" || typeof message.id === "number")
        ? String(message.id)
        : undefined;
    return new ZCodeAppServerProtocolParseError({
      operation: "route-wire-message",
      ...diagnostics,
      presentFields,
      ...(method === undefined ? {} : { method }),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

export class ZCodeAppServerTransportError extends Schema.TaggedError<ZCodeAppServerTransportError>()(
  "ZCodeAppServerTransportError",
  {
    operation: ZCodeAppServerTransportOperation,
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `ZCode app-server transport operation '${this.operation}' failed.`;
  }
}

export class ZCodeAppServerInputStreamEndedError extends Schema.TaggedError<ZCodeAppServerInputStreamEndedError>()(
  "ZCodeAppServerInputStreamEndedError",
  {},
) {
  override get message() {
    return "ZCode app-server input stream ended.";
  }
}

/** Storage gate never reached `phase: "ready"`; carries the protocol errorCode. */
export class ZCodeAppServerStorageStartupError extends Schema.TaggedError<ZCodeAppServerStorageStartupError>()(
  "ZCodeAppServerStorageStartupError",
  {
    errorCode: ZCodeStorageStartupErrorCode,
    attemptId: Schema.optionalKey(Schema.String),
    databaseId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `ZCode app-server storage startup failed: ${this.errorCode}`;
  }
}

export class ZCodeAppServerRequestTimeoutError extends Schema.TaggedError<ZCodeAppServerRequestTimeoutError>()(
  "ZCodeAppServerRequestTimeoutError",
  {
    method: Schema.String,
    requestId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message() {
    return `ZCode app-server request '${this.method}' timed out after ${this.timeoutMs}ms.`;
  }
}

export class ZCodeAppServerRequestError extends Schema.TaggedError<ZCodeAppServerRequestError>()(
  "ZCodeAppServerRequestError",
  {
    code: Schema.Number,
    errorMessage: Schema.String,
    data: Schema.optional(Schema.Unknown),
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    operation: Schema.optionalKey(ZCodeAppServerRequestOperation),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(ZCodeAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    payloadKind: Schema.optionalKey(ZCodeAppServerPayloadKind),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(
    error: ZCodeAppServerProtocolErrorShape,
    method: string,
    requestId: string,
  ) {
    return new ZCodeAppServerRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method,
      requestId,
      operation: "receive-response",
      cause: error,
    });
  }

  static fromAppServerError(error: ZCodeAppServerError, method: string) {
    if (error._tag === "ZCodeAppServerRequestError") {
      return error;
    }
    return ZCodeAppServerRequestError.internalError(
      `ZCode app-server request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-request",
        cause: error,
      },
    );
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new ZCodeAppServerRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidRequest(message = "Invalid request", data?: unknown) {
    return new ZCodeAppServerRequestError({
      code: -32600,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static methodNotFound(method: string) {
    return new ZCodeAppServerRequestError({
      code: -32601,
      errorMessage: `Method not found: ${method}`,
    });
  }

  static invalidParams(
    message = "Invalid params",
    data?: unknown,
    diagnostics: ZCodeAppServerRequestDiagnostics = {},
  ) {
    return new ZCodeAppServerRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static invalidPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    cause: Schema.SchemaError,
  ) {
    const diagnostics = schemaIssueDiagnostics(cause.issue);
    return new ZCodeAppServerRequestError({
      code: -32602,
      errorMessage: `Invalid payload for method '${method}' during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
      cause,
    });
  }

  static unexpectedPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    payload: unknown,
  ) {
    const diagnostics = { payloadKind: payloadKind(payload) };
    return new ZCodeAppServerRequestError({
      code: -32602,
      errorMessage: `Method '${method}' does not accept a payload during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
    });
  }

  static internalError(
    message = "Internal error",
    data?: unknown,
    diagnostics: ZCodeAppServerRequestDiagnostics = {},
  ) {
    return new ZCodeAppServerRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static overloaded(message = "Server overloaded; retry later.", data?: unknown) {
    return new ZCodeAppServerRequestError({
      code: -32001,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  toProtocolError(): ZCodeAppServerProtocolErrorShape {
    return {
      code: this.code,
      message: this.errorMessage,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

export const ZCodeAppServerError = Schema.Union([
  ZCodeAppServerRequestError,
  ZCodeAppServerRequestTimeoutError,
  ZCodeAppServerStorageStartupError,
  ZCodeAppServerSpawnError,
  ZCodeAppServerProcessExitedError,
  ZCodeAppServerProtocolParseError,
  ZCodeAppServerTransportError,
  ZCodeAppServerInputStreamEndedError,
]);

export type ZCodeAppServerError = typeof ZCodeAppServerError.Type;

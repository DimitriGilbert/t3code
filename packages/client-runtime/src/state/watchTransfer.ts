import * as Schema from "effect/Schema";
import {
  WATCH_WIDGET_EXPORT_FORMAT,
  WATCH_WIDGET_EXPORT_FORMAT_VERSION,
  WatchWidgetExportDocument,
  type WatchConnectorInstance,
  type WatchConnectorPack,
  type WatchPackWidgetSource,
} from "@t3tools/contracts";

import { watchAgentSourceId } from "./watchMounts.ts";
import { watchFirstPartyWidgetSpec } from "./watchPages.ts";

/**
 * Client-side plumbing for `t3.watch-widget` export documents: the byte cap
 * and friendly failures for the import dialog, the download filename, and the
 * non-blocking preview warnings. The server re-validates everything — this
 * layer exists so a bad file fails before any RPC and the preview can flag
 * what the target environment is missing.
 */

/**
 * A widget document is a few KB (plus embedded TSX), so anything past this is
 * not a widget file. Applied to `file.size` before the bytes are read and to
 * the UTF-8 byte length of pasted text — the same posture as theme import.
 */
export const WATCH_WIDGET_FILE_MAX_BYTES = 512 * 1024;

const encoder = new TextEncoder();

const formatByteSize = (bytes: number): string =>
  bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

const decodeExportDocument = Schema.decodeUnknownSync(WatchWidgetExportDocument);

/** The error to show for a file too large to be a widget export, else null. */
export function describeOversizedWidgetFile(bytes: number): string | null {
  if (bytes <= WATCH_WIDGET_FILE_MAX_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Widget exports carry one widget's config and optional source, so this one was not read (limit ${formatByteSize(WATCH_WIDGET_FILE_MAX_BYTES)}).`;
}

/**
 * Parses pasted/dropped text into a `t3.watch-widget` document. Throws
 * `Error` with a user-readable message — the dialog renders it verbatim.
 * Runs the schema decode after cheap structural checks so a wrong file says
 * "not a widget export" instead of a decode dump.
 */
export function parseWatchWidgetExportText(text: string): WatchWidgetExportDocument {
  // Byte size, not UTF-16 units — `text.length` undercounts multibyte input.
  const oversized = describeOversizedWidgetFile(encoder.encode(text).byteLength);
  if (oversized !== null) throw new Error(oversized);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("That file is not a T3 widget export.");
  }
  const { format, formatVersion } = value as { format?: unknown; formatVersion?: unknown };
  if (format !== WATCH_WIDGET_EXPORT_FORMAT) {
    throw new Error("That file is not a T3 widget export.");
  }
  if (formatVersion !== WATCH_WIDGET_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `This widget export uses format version ${String(formatVersion)}; this version of T3 Code understands ${WATCH_WIDGET_EXPORT_FORMAT_VERSION}.`,
    );
  }
  try {
    return decodeExportDocument(value);
  } catch (error) {
    throw new Error(
      `That file is not a valid widget export: ${error instanceof Error ? error.message : "decode failed"}.`,
      { cause: error },
    );
  }
}

const sanitizeFileSlug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * `t3-widget-<slug>.json` — the registry kind for first-party widgets, the
 * source-id tail for `agent:` kinds so downloads from different publications
 * do not collide.
 */
export function watchWidgetExportFileName(
  document: Pick<WatchWidgetExportDocument, "kind">,
): string {
  const slug = document.kind.startsWith("agent:")
    ? `agent-${sanitizeFileSlug(document.kind.slice(-8)) || "widget"}`
    : sanitizeFileSlug(document.kind) || "widget";
  return `t3-widget-${slug}.json`;
}

/**
 * Non-blocking preview warnings for a document about to be imported: kind
 * unknown to this build, `pack:` provenance without the pack installed, and a
 * connector binding that dangles on this environment. The server stays
 * authoritative — these only prepare the user for the likely outcome.
 */
export function watchWidgetImportWarnings(
  document: WatchWidgetExportDocument,
  context: {
    readonly packs: ReadonlyArray<Pick<WatchConnectorPack, "packId" | "archivedAt">>;
    readonly instances: ReadonlyArray<Pick<WatchConnectorInstance, "id" | "archivedAt">>;
    readonly widgetSources: ReadonlyArray<
      Pick<WatchPackWidgetSource, "packId" | "sourceId" | "archivedAt">
    >;
  },
): ReadonlyArray<string> {
  const warnings: string[] = [];
  const sourceId = watchAgentSourceId(document.kind);
  if (watchFirstPartyWidgetSpec(document.kind) === undefined && sourceId === undefined) {
    warnings.push(
      `"${document.kind}" isn't a widget kind this version's catalog knows — it will render as a placeholder.`,
    );
  }
  const provenance = document.provenance;
  if (provenance !== undefined) {
    const packId = provenance.slice("pack:".length);
    const pack = context.packs.find(
      (entry) => entry.packId === packId && entry.archivedAt === null,
    );
    const registered =
      sourceId !== undefined &&
      context.widgetSources.some(
        (entry) =>
          entry.packId === packId && entry.sourceId === sourceId && entry.archivedAt === null,
      );
    if (pack === undefined || !registered) {
      warnings.push(
        `This widget's code ships with connector pack "${packId}", which isn't installed here — install the pack first or the import will fail.`,
      );
    }
  }
  const binding =
    document.config.source?.kind === "connector" ? document.config.source.binding : undefined;
  if (
    binding !== undefined &&
    !context.instances.some((instance) => instance.id === binding && instance.archivedAt === null)
  ) {
    warnings.push(
      "The connector this widget was bound to doesn't exist here — repoint it in Configure after importing.",
    );
  }
  return warnings;
}

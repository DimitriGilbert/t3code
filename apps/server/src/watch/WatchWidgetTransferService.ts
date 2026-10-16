import {
  WatchLayoutCollisionError,
  WatchPageError,
  WatchPageRevisionConflictError,
  WATCH_WIDGET_EXPORT_FORMAT,
  WATCH_WIDGET_EXPORT_FORMAT_VERSION,
  type WatchWidgetExportDocument,
  type WatchWidgetExportInput,
  type WatchWidgetExportResult,
  type WatchWidgetId,
  type WatchWidgetImportInput,
  type WatchWidgetImportResult,
  type WatchWidgetPlacement,
  WatchWidgetSourceError,
  WatchWidgetSourceId,
  type WatchWidgetSourceRecord,
  WatchWidgetPackProvenance,
  WatchWidgetTransferError,
  type WatchWidgetTransferErrorReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WatchPageService from "./WatchPageService.ts";
import * as WidgetTranspileService from "./WidgetTranspileService.ts";

/**
 * Moves one widget between pages and environments as a `t3.watch-widget` JSON
 * document. `agent:` kinds embed authored source + bridge manifest, never the
 * compiled artifact; import republishes through the rate-limited `publish`
 * path and lands via the revision- and collision-checked `addWidget`.
 */
const AGENT_KIND_PREFIX = "agent:";
const GRID_COLUMNS = 12;
const DEFAULT_WIDGET_SIZE = { w: 4, h: 3 } as const;

const isWatchWidgetSourceId = Schema.is(WatchWidgetSourceId);
const isPackProvenance = Schema.is(WatchWidgetPackProvenance);

const transferError = (
  reason: WatchWidgetTransferErrorReason,
  message: string,
  options?: { readonly widgetId?: WatchWidgetId; readonly cause?: unknown },
) =>
  new WatchWidgetTransferError({
    message,
    reason,
    ...(options?.widgetId === undefined ? {} : { widgetId: options.widgetId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

/** The published source id an `agent:` kind names; null for other kinds and malformed `agent:` kinds. */
const agentSourceIdOf = (kind: string): WatchWidgetSourceId | null => {
  if (!kind.startsWith(AGENT_KIND_PREFIX)) return null;
  const candidate = kind.slice(AGENT_KIND_PREFIX.length);
  return isWatchWidgetSourceId(candidate) ? candidate : null;
};

const isPageError = Schema.is(WatchPageError);
const isRevisionConflictError = Schema.is(WatchPageRevisionConflictError);
const isCollisionError = Schema.is(WatchLayoutCollisionError);
const isSourceError = Schema.is(WatchWidgetSourceError);
const isTransferError = Schema.is(WatchWidgetTransferError);

type TransferTypedError =
  | WatchWidgetTransferError
  | WatchPageError
  | WatchPageRevisionConflictError
  | WatchLayoutCollisionError
  | WatchWidgetSourceError;

/** Already a typed watch error; re-fail it instead of re-wrapping in `WatchPageError`. */
const isTypedTransferError = (cause: unknown): cause is TransferTypedError =>
  isTransferError(cause) ||
  isPageError(cause) ||
  isRevisionConflictError(cause) ||
  isCollisionError(cause) ||
  isSourceError(cause);

export class WatchWidgetTransferService extends Context.Service<
  WatchWidgetTransferService,
  {
    readonly exportWidget: (
      input: WatchWidgetExportInput,
    ) => Effect.Effect<
      WatchWidgetExportResult,
      WatchWidgetTransferError | WatchPageError | WatchWidgetSourceError
    >;
    readonly importWidget: (
      input: WatchWidgetImportInput,
    ) => Effect.Effect<
      WatchWidgetImportResult,
      | WatchWidgetTransferError
      | WatchPageError
      | WatchPageRevisionConflictError
      | WatchLayoutCollisionError
      | WatchWidgetSourceError
    >;
  }
>()("t3/watch/WatchWidgetTransferService") {}

export const layer = Layer.effect(
  WatchWidgetTransferService,
  Effect.gen(function* () {
    const pages = yield* WatchPageService.WatchPageService;
    const sources = yield* WidgetTranspileService.WidgetTranspileService;

    const exportWidget: (typeof WatchWidgetTransferService.Service)["exportWidget"] = Effect.fn(
      "WatchWidgetTransferService.exportWidget",
    )(function* (input) {
      const widget = yield* pages.getWidget(input.widgetId);
      if (widget === null) {
        return yield* transferError("widgetNotFound", "Watch widget not found.", {
          widgetId: input.widgetId,
        });
      }
      let source: WatchWidgetExportDocument["source"];
      if (widget.kind.startsWith(AGENT_KIND_PREFIX)) {
        const sourceId = agentSourceIdOf(widget.kind);
        const record = sourceId === null ? null : (yield* sources.get({ sourceId })).source;
        // A document with a dangling `agent:` kind is dead weight — the
        // widget would render its source-missing placeholder forever.
        if (record === null) {
          return yield* transferError(
            "sourceUnavailable",
            "The widget's source is not available on this server.",
            { widgetId: input.widgetId },
          );
        }
        source = { source: record.source, manifest: record.manifest };
      }
      const document: WatchWidgetExportDocument = {
        format: WATCH_WIDGET_EXPORT_FORMAT,
        formatVersion: WATCH_WIDGET_EXPORT_FORMAT_VERSION,
        kind: widget.kind,
        ...(isPackProvenance(widget.provenance) ? { provenance: widget.provenance } : {}),
        config: widget.config,
        sizeHint: {
          w: widget.placement.w,
          h: widget.placement.h,
          ...(widget.placement.minCols === undefined ? {} : { minCols: widget.placement.minCols }),
        },
        ...(source === undefined ? {} : { source }),
      };
      return { document };
    });

    /**
     * Resolves the document's `agent:` kind to a source record, or fails the
     * import. `pack:` provenance never republishes — pack code is governed by
     * the human-confirmed install — so its record is looked up for the result
     * only, and `addWidget`'s provenance check stays the gate.
     */
    const resolveImportSource = Effect.fn("WatchWidgetTransferService.resolveImportSource")(
      function* (
        document: WatchWidgetExportDocument,
      ): Effect.fn.Return<
        WatchWidgetSourceRecord | null,
        WatchWidgetTransferError | WatchWidgetSourceError
      > {
        if (!document.kind.startsWith(AGENT_KIND_PREFIX)) return null;
        const kindSourceId = agentSourceIdOf(document.kind);
        if (document.provenance !== undefined) {
          return kindSourceId === null
            ? null
            : (yield* sources.get({ sourceId: kindSourceId })).source;
        }
        if (document.source !== undefined) {
          // A malformed `agent:` kind can never match the recomputed
          // sourceId — reject before publish so the import spends no
          // rate-limit budget and leaves no orphan source record.
          if (kindSourceId === null) {
            return yield* transferError(
              "sourceIdMismatch",
              "The embedded widget source does not match the kind the document declares.",
            );
          }
          // The rate-limited agent path on purpose: an imported widget is
          // unreviewed code, exactly what the publish cap exists for. A
          // cache-hit republish does not consume budget.
          const { source: record } = yield* sources.publish({
            source: document.source.source,
            manifest: document.source.manifest,
          });
          // The embedded source is the integrity check: it must recompute to
          // the declared kind's sourceId, or the document's kind and source
          // disagree and the import would mount code the doc did not name.
          if (record.sourceId !== kindSourceId) {
            return yield* transferError(
              "sourceIdMismatch",
              "The embedded widget source does not match the kind the document declares.",
            );
          }
          return record;
        }
        if (kindSourceId === null) {
          return yield* transferError(
            "sourceUnavailable",
            "The document's widget kind names no resolvable source.",
          );
        }
        // No embedded source: the record must already exist here. Any status
        // is acceptable — a `failed` record still produces a widget that
        // renders the typed `transpileFailed` state.
        const { source: record } = yield* sources.get({ sourceId: kindSourceId });
        if (record === null) {
          return yield* transferError(
            "sourceUnavailable",
            "The widget's source is not published on this server, and the document does not embed it.",
          );
        }
        return record;
      },
    );

    const importWidget: (typeof WatchWidgetTransferService.Service)["importWidget"] = Effect.fn(
      "WatchWidgetTransferService.importWidget",
    )(
      function* (input) {
        const document = input.document;
        if (document.formatVersion !== WATCH_WIDGET_EXPORT_FORMAT_VERSION) {
          return yield* transferError(
            "unsupportedFormatVersion",
            `This widget export uses format version ${document.formatVersion}; this server understands ${WATCH_WIDGET_EXPORT_FORMAT_VERSION}.`,
          );
        }
        // Fail fast before any publish: a missing/archived page or stale
        // revision rejects addWidget anyway, so checking first spares the
        // publish budget. addWidget re-checks in its own transaction; the
        // listed widgets double as the append-placement input.
        const { pages: listedPages, widgets: listedWidgets } = yield* pages.list({
          includeArchived: true,
        });
        const page = listedPages.find((entry) => entry.id === input.pageId);
        if (page === undefined) {
          return yield* new WatchPageError({
            message: "Watch page not found.",
            pageId: input.pageId,
          });
        }
        if (page.archivedAt !== null) {
          return yield* new WatchPageError({
            message: "Watch page is archived.",
            pageId: input.pageId,
          });
        }
        if (page.revision !== input.expectedRevision) {
          return yield* new WatchPageRevisionConflictError({
            pageId: input.pageId,
            expectedRevision: input.expectedRevision,
            currentRevision: page.revision,
            message: `Watch page changed since revision ${input.expectedRevision}; reload and retry.`,
          });
        }
        const source = yield* resolveImportSource(document);
        let placement: WatchWidgetPlacement | undefined = input.placement;
        if (placement === undefined) {
          const w = Math.min(document.sizeHint?.w ?? DEFAULT_WIDGET_SIZE.w, GRID_COLUMNS);
          const minCols =
            document.sizeHint?.minCols === undefined
              ? undefined
              : Math.min(document.sizeHint.minCols, w);
          // No placement supplied: append below the page's deepest widget —
          // always inside the grid and never overlapping, so `addWidget`
          // cannot reject it.
          const bottom = listedWidgets.reduce(
            (max, entry) =>
              entry.pageId === input.pageId
                ? Math.max(max, entry.placement.y + entry.placement.h)
                : max,
            0,
          );
          placement = {
            x: 0,
            y: bottom,
            w,
            h: document.sizeHint?.h ?? DEFAULT_WIDGET_SIZE.h,
            ...(minCols === undefined ? {} : { minCols }),
          };
        }
        const { widget } = yield* pages.addWidget({
          pageId: input.pageId,
          expectedRevision: input.expectedRevision,
          kind: document.kind,
          config: document.config,
          placement,
          ...(document.provenance === undefined ? {} : { provenance: document.provenance }),
        });
        return { widget, source };
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isTypedTransferError(cause)
              ? cause
              : new WatchPageError({
                  message: "Could not import the watch widget.",
                  pageId: input.pageId,
                  cause,
                }),
          ),
        ),
    );

    return WatchWidgetTransferService.of({ exportWidget, importWidget });
  }),
);

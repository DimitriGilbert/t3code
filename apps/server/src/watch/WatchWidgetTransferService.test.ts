import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  WatchPageId,
  WatchPageRevisionConflictError,
  WatchWidgetExportDocument,
  WatchWidgetId,
  WatchWidgetTransferError,
  type WatchLayoutCollisionError,
  type WatchPageError,
  type WatchWidgetSourceError,
  type WatchWidgetTransferErrorReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WatchPageService from "./WatchPageService.ts";
import * as WatchWidgetTransferService from "./WatchWidgetTransferService.ts";
import * as WidgetTranspileService from "./WidgetTranspileService.ts";

const MANIFEST = { subscriptions: [], actions: [] };

const decodeExportDocumentJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(WatchWidgetExportDocument),
);

/** The transpiler stub: emit text that survives the artifact contract checks. */
const layerTranspiler = Layer.succeed(WidgetTranspileService.WidgetSourceTranspiler, {
  transpile: (source) => Effect.succeed(`/* ${source.length} bytes */ T3.render();`),
});

const layerDeps = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  NodeCrypto.layer,
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "widget-transfer-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  layerTranspiler,
);

// The shared WatchPageService/WidgetTranspileService instances inside the
// transfer layer keep notifications consistent with a page service used
// directly by the test.
const layerTest = Layer.mergeAll(
  WatchWidgetTransferService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(WatchPageService.layer, WidgetTranspileService.makeLayer())),
    Layer.provide(layerDeps),
  ),
  layerDeps,
);

const createPage = (name: string) =>
  Effect.flatMap(WatchPageService.WatchPageService, (pages) =>
    pages.create({ name }).pipe(Effect.map((result) => result.page)),
  );

const publishSource = (source: string) =>
  Effect.flatMap(WidgetTranspileService.WidgetTranspileService, (sources) =>
    sources.publish({ source, manifest: MANIFEST }).pipe(Effect.map((result) => result.source)),
  );

const expectTransferError = (
  reason: WatchWidgetTransferErrorReason,
  effect: Effect.Effect<
    unknown,
    | WatchWidgetTransferError
    | WatchPageError
    | WatchPageRevisionConflictError
    | WatchLayoutCollisionError
    | WatchWidgetSourceError
  >,
) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        assert.instanceOf(error, WatchWidgetTransferError);
        assert.equal((error as WatchWidgetTransferError).reason, reason);
        return Effect.void;
      },
      onSuccess: () => Effect.die(new Error(`expected a ${reason} WatchWidgetTransferError`)),
    }),
  );

it.effect("exports a first-party widget as kind + config with no source", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const page = yield* createPage("Page");
    const pages = yield* WatchPageService.WatchPageService;
    const { widget } = yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      config: { source: { kind: "threads" } },
      placement: { x: 0, y: 0, w: 7, h: 4 },
    });

    const { document } = yield* transfer.exportWidget({ widgetId: widget.id });
    assert.equal(document.format, "t3.watch-widget");
    assert.equal(document.formatVersion, 1);
    assert.equal(document.kind, "active-work");
    assert.deepEqual(document.config, { source: { kind: "threads" } });
    assert.deepEqual(document.sizeHint, { w: 7, h: 4 });
    assert.isUndefined(document.provenance);
    assert.isUndefined(document.source);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("fails export when the widget or its agent source is missing", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const pages = yield* WatchPageService.WatchPageService;
    yield* expectTransferError(
      "widgetNotFound",
      transfer.exportWidget({ widgetId: WatchWidgetId.make("watch-widget:missing") }),
    );

    // An agent kind whose source record was never published has nothing to
    // carry — the document would import to a permanently broken widget.
    const page = yield* createPage("Page");
    const { widget } = yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: `agent:watch-widget-source:${"0".repeat(64)}`,
      placement: { x: 0, y: 0, w: 4, h: 3 },
    });
    yield* expectTransferError("sourceUnavailable", transfer.exportWidget({ widgetId: widget.id }));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("exports an agent widget with the authored source embedded, never the artifact", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const pages = yield* WatchPageService.WatchPageService;
    const published = yield* publishSource("const App = () => <div>hi</div>;");
    const page = yield* createPage("Page");
    const { widget } = yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: `agent:${published.sourceId}`,
      placement: { x: 0, y: 0, w: 4, h: 3, minCols: 2 },
    });

    const { document } = yield* transfer.exportWidget({ widgetId: widget.id });
    assert.equal(document.kind, `agent:${published.sourceId}`);
    assert.deepEqual(document.sizeHint, { w: 4, h: 3, minCols: 2 });
    // Authored text and manifest ride along; the artifact hash and compiled
    // bundle never cross — they are recomputed at import.
    assert.deepEqual(document.source, { source: published.source, manifest: MANIFEST });
    const keys = Object.keys(document.source ?? {});
    assert.deepEqual(keys.sort(), ["manifest", "source"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("import republishes embedded source and lands the widget at the appended slot", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const pages = yield* WatchPageService.WatchPageService;
    const published = yield* publishSource("T3.render(() => 1);");
    const page = yield* createPage("Page");
    yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const pageNow = (yield* pages.list({})).pages[0]!;

    const document: WatchWidgetExportDocument = {
      format: "t3.watch-widget",
      formatVersion: 1,
      kind: `agent:${published.sourceId}`,
      config: {},
      source: { source: "T3.render(() => 1);", manifest: MANIFEST },
    };
    const { widget, source } = yield* transfer.importWidget({
      pageId: page.id,
      expectedRevision: pageNow.revision,
      document,
    });
    // Deterministic publish: the embedded source recomputes to the declared
    // kind — and the widget lands below the existing 4-row widget.
    assert.equal(source?.sourceId, published.sourceId);
    assert.equal(source?.status, "ready");
    assert.equal(widget.kind, `agent:${published.sourceId}`);
    assert.equal(widget.provenance, "agentPublished");
    assert.deepEqual(widget.placement, { x: 0, y: 4, w: 4, h: 3 });
    const after = (yield* pages.list({})).pages[0]!;
    // Membership writes bump both revisions.
    assert.isTrue(after.revision > pageNow.revision);
    assert.isTrue(after.mobileRevision > pageNow.mobileRevision);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects an embedded source that does not recompute to the declared kind", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const page = yield* createPage("Page");
    // The kind names a sourceId the embedded source does not produce — a
    // swapped-source document must not silently rewrite the kind.
    const document: WatchWidgetExportDocument = {
      format: "t3.watch-widget",
      formatVersion: 1,
      kind: `agent:watch-widget-source:${"f".repeat(64)}`,
      config: {},
      source: { source: "T3.render(() => 1);", manifest: MANIFEST },
    };
    yield* expectTransferError(
      "sourceIdMismatch",
      transfer.importWidget({
        pageId: page.id,
        expectedRevision: page.revision,
        document,
      }),
    );
    assert.equal(
      (yield* WatchPageService.WatchPageService.pipe(Effect.flatMap((p) => p.list({})))).widgets
        .length,
      0,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a document from a newer format version", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const page = yield* createPage("Page");
    yield* expectTransferError(
      "unsupportedFormatVersion",
      transfer.importWidget({
        pageId: page.id,
        expectedRevision: page.revision,
        document: {
          format: "t3.watch-widget",
          formatVersion: 2,
          kind: "active-work",
          config: {},
        },
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "imports an agent widget without embedded source only when the record exists locally",
  () =>
    Effect.gen(function* () {
      const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
      const pages = yield* WatchPageService.WatchPageService;
      const page = yield* createPage("Page");
      const missing: WatchWidgetExportDocument = {
        format: "t3.watch-widget",
        formatVersion: 1,
        kind: `agent:watch-widget-source:${"d".repeat(64)}`,
        config: {},
      };
      // A malformed agent kind and an unknown sourceId both fail the same way.
      yield* expectTransferError(
        "sourceUnavailable",
        transfer.importWidget({
          pageId: page.id,
          expectedRevision: page.revision,
          document: { ...missing, kind: "agent:not-a-source-id" },
        }),
      );
      const published = yield* publishSource("T3.render(() => 2);");
      yield* expectTransferError(
        "sourceUnavailable",
        transfer.importWidget({
          pageId: page.id,
          expectedRevision: page.revision,
          document: {
            ...missing,
            kind: `agent:watch-widget-source:${"e".repeat(64)}`,
          },
        }),
      );

      const pageNow = (yield* pages.list({})).pages[0]!;
      const { widget, source } = yield* transfer.importWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        document: { ...missing, kind: `agent:${published.sourceId}` },
      });
      assert.equal(widget.kind, `agent:${published.sourceId}`);
      assert.equal(source?.sourceId, published.sourceId);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("pack provenance imports rely on the live pack registration", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const sql = yield* SqlClient.SqlClient;
    const page = yield* createPage("Page");
    const published = yield* publishSource("T3.render(() => 3);");
    const document: WatchWidgetExportDocument = {
      format: "t3.watch-widget",
      formatVersion: 1,
      kind: `agent:${published.sourceId}`,
      provenance: "pack:pack.test",
      config: {},
      // Pack docs carry the embedded source for uniformity, but import never
      // republishes it — the pack install owns that code.
      source: { source: "T3.render(() => 3);", manifest: MANIFEST },
    };

    // No pack installed: addWidget's provenance check rejects the marker.
    const rejected = yield* transfer
      .importWidget({ pageId: page.id, expectedRevision: page.revision, document })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "WatchPageError");

    yield* sql`
      INSERT INTO watch_connector_packs ${sql.insert({
        pack_id: "pack.test",
        schema_version: 1,
        manifest_json: "{}",
        manifest_hash: "manifest-hash",
        origin_json: "{}",
        content_hash: "content-hash",
        approved_at: "2025-01-01T00:00:00.000Z",
        archived_at: null,
      })}
    `;
    yield* sql`
      INSERT INTO watch_pack_widget_sources ${sql.insert({
        pack_id: "pack.test",
        schema_version: 1,
        name: "pack-chart",
        file: "widgets/chart.tsx",
        source_id: published.sourceId,
        created_at: "2025-01-01T00:00:00.000Z",
      })}
    `;

    const { widget, source } = yield* transfer.importWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      document,
    });
    assert.equal(widget.provenance, "pack:pack.test");
    // The registered record resolves for the result without a republish.
    assert.equal(source?.sourceId, published.sourceId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a stale expectedRevision rejects the import", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const page = yield* createPage("Page");
    const conflict = yield* transfer
      .importWidget({
        pageId: page.id,
        expectedRevision: page.revision + 9,
        document: {
          format: "t3.watch-widget",
          formatVersion: 1,
          kind: "active-work",
          config: {},
        },
      })
      .pipe(Effect.flip);
    assert.instanceOf(conflict, WatchPageRevisionConflictError);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("uses the size hint and caller placement when provided", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const pages = yield* WatchPageService.WatchPageService;
    const page = yield* createPage("Page");
    yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 12, h: 2 },
    });
    const pageNow = (yield* pages.list({})).pages[0]!;

    const hinted = yield* transfer.importWidget({
      pageId: page.id,
      expectedRevision: pageNow.revision,
      document: {
        format: "t3.watch-widget",
        formatVersion: 1,
        kind: "needs-attention",
        config: {},
        sizeHint: { w: 6, h: 5, minCols: 3 },
      },
    });
    assert.deepEqual(hinted.widget.placement, { x: 0, y: 2, w: 6, h: 5, minCols: 3 });

    const after = (yield* pages.list({})).pages[0]!;
    const placed = yield* transfer.importWidget({
      pageId: page.id,
      expectedRevision: after.revision,
      document: {
        format: "t3.watch-widget",
        formatVersion: 1,
        kind: "connector-status",
        config: {},
      },
      placement: { x: 6, y: 7, w: 6, h: 2 },
    });
    assert.deepEqual(placed.widget.placement, { x: 6, y: 7, w: 6, h: 2 });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("getWidget and listWidgetsForPage read widget rows for the transfer layer", () =>
  Effect.gen(function* () {
    const pages = yield* WatchPageService.WatchPageService;
    const page = yield* createPage("Page");
    const { widget } = yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 4, h: 3 },
    });
    assert.equal((yield* pages.getWidget(widget.id))?.id, widget.id);
    assert.isNull(yield* pages.getWidget(WatchWidgetId.make("watch-widget:gone")));
    assert.deepEqual(
      (yield* pages.listWidgetsForPage(page.id)).map((entry) => entry.id),
      [widget.id],
    );
    const missing = yield* pages
      .listWidgetsForPage(WatchPageId.make("watch-page:missing"))
      .pipe(Effect.flip);
    assert.equal(missing._tag, "WatchPageError");
  }).pipe(Effect.provide(layerTest)),
);

// The document schema stays the wire contract: decode once, share everywhere.
it.effect("the export document schema round-trips an exported widget", () =>
  Effect.gen(function* () {
    const transfer = yield* WatchWidgetTransferService.WatchWidgetTransferService;
    const pages = yield* WatchPageService.WatchPageService;
    const published = yield* publishSource("T3.render(() => 4);");
    const page = yield* createPage("Page");
    const { widget } = yield* pages.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: `agent:${published.sourceId}`,
      placement: { x: 0, y: 0, w: 4, h: 3 },
    });
    const { document } = yield* transfer.exportWidget({ widgetId: widget.id });
    const reparsed = decodeExportDocumentJson(JSON.stringify(document));
    assert.deepEqual(reparsed, document);
  }).pipe(Effect.provide(layerTest)),
);

import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  WatchLayoutCollisionError,
  WatchPageId,
  WatchPageRevisionConflictError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WatchPageService from "./WatchPageService.ts";

const layerTest = Layer.provideMerge(
  WatchPageService.layer,
  Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer),
);

const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const layerMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `github.com/t3tools/${workspaceRoot.split("/").at(-1)}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `git@github.com:t3tools/${workspaceRoot.split("/").at(-1)}.git`,
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: (workspaceRoot) => Effect.succeed(`${workspaceRoot}/favicon.svg`),
    invalidate: () => Effect.void,
  }),
);

const layerProjectDelete = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(WatchPageService.layer),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerMetadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "watch-page-test-" })),
  Layer.provide(NodeServices.layer),
);

const createPage = (name: string) =>
  Effect.flatMap(WatchPageService.WatchPageService, (watch) => watch.create({ name }));

/** Direct row insert for tests that need order keys the API never mints. */
const insertPageRow = (row: {
  readonly pageId: string;
  readonly orderKey: string;
  readonly archivedAt?: string;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`
      INSERT INTO watch_pages ${sql.insert({
        page_id: row.pageId,
        name: row.pageId,
        scope: "global",
        project_id: null,
        order_key: row.orderKey,
        revision: 1,
        mobile_revision: 1,
        archived_at: row.archivedAt ?? null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      })}
    `,
  );

const allOrderKeys = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ order_key: string }>`SELECT order_key FROM watch_pages`.pipe(
    Effect.map((rows) => rows.map((row) => row.order_key)),
  ),
);

it.effect("creates, lists, renames, reorders, duplicates, and deletes pages", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page: first } = yield* createPage("First");
    const { page: second } = yield* createPage("Second");
    assert.equal(first.scope, "global");
    assert.isNull(first.projectId);
    assert.equal(first.revision, 1);
    assert.isNull(first.archivedAt);
    assert.isTrue(first.orderKey < second.orderKey);

    const renamed = yield* watch.rename({ pageId: first.id, name: "Renamed" });
    assert.equal(renamed.page.name, "Renamed");
    assert.isTrue(renamed.page.revision > first.revision);

    const reordered = yield* watch.reorder({ pageId: first.id, beforePageId: null });
    assert.deepEqual(
      (yield* watch.list({})).pages.map((page) => page.id),
      [second.id, reordered.page.id],
    );

    const duplicated = yield* watch.duplicate({ pageId: second.id });
    assert.equal(duplicated.page.name, "Second copy");
    const listed = yield* watch.list({});
    assert.equal(listed.pages.length, 3);

    yield* watch.delete({ pageId: first.id });
    assert.equal((yield* watch.list({})).pages.length, 2);
    const missing = yield* watch.delete({ pageId: first.id }).pipe(Effect.flip);
    assert.equal(missing._tag, "WatchPageError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("concurrent creates mint distinct order keys", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const [first, second] = yield* Effect.all(
      [watch.create({ name: "One" }), watch.create({ name: "Two" })],
      { concurrency: 2 },
    );
    // Without the transaction around the max-key read, both creates can read
    // the same lastKey and mint the identical successor key.
    assert.notEqual(first.page.orderKey, second.page.orderKey);
    const keys = yield* allOrderKeys;
    assert.equal(new Set(keys).size, keys.length);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mints reorder and duplicate keys past keys archived rows still hold", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    // Live "m"/"n"/"o" sit around archived rows holding "mk" and the
    // midpoint of "m" and "n" ("mn") — minting between the live neighbors
    // without reserving those keys collides with the parked rows.
    yield* insertPageRow({ pageId: "watch-page:left", orderKey: "m" });
    yield* insertPageRow({ pageId: "watch-page:right", orderKey: "n" });
    yield* insertPageRow({ pageId: "watch-page:tail", orderKey: "o" });
    yield* insertPageRow({
      pageId: "watch-page:archived-mid",
      orderKey: "mn",
      archivedAt: "2025-01-02T00:00:00.000Z",
    });
    yield* insertPageRow({
      pageId: "watch-page:archived-lo",
      orderKey: "mk",
      archivedAt: "2025-01-02T00:00:00.000Z",
    });

    const leftId = WatchPageId.make("watch-page:left");
    const rightId = WatchPageId.make("watch-page:right");
    const tailId = WatchPageId.make("watch-page:tail");

    // Moving "o" between live "m" and "n" mints midpoint "mn" — reserved —
    // so the write must step past the parked key instead of reusing it.
    yield* watch.reorder({ pageId: tailId, beforePageId: rightId });
    const tailNow = (yield* watch.list({})).pages.find((page) => page.id === tailId)!;
    assert.notEqual(tailNow.orderKey, "mn");
    assert.isTrue(tailNow.orderKey > "m" && tailNow.orderKey < "n");

    // Duplicating "m" mints midpoint("m", tail) = "mk" — also reserved.
    const copy = yield* watch.duplicate({ pageId: leftId });
    assert.notEqual(copy.page.orderKey, "mk");
    assert.notEqual(copy.page.orderKey, "mn");
    assert.isTrue(copy.page.orderKey > "m" && copy.page.orderKey < tailNow.orderKey);

    const keys = yield* allOrderKeys;
    assert.equal(new Set(keys).size, keys.length);

    // Restoring the parked page slots it back between live neighbors on its
    // own key — nothing collides.
    yield* watch.restore({ pageId: WatchPageId.make("watch-page:archived-mid") });
    const live = yield* watch.list({});
    assert.deepEqual(
      live.pages.map((page) => page.id),
      [leftId, WatchPageId.make("watch-page:archived-mid"), copy.page.id, tailId, rightId],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("respread order keys skip keys archived rows still hold", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    // "za" is corrupt — a trailing "a" is not a valid key — so minting next
    // to it falls back to a full respread of the live rows.
    yield* insertPageRow({ pageId: "watch-page:mover", orderKey: "m" });
    yield* insertPageRow({ pageId: "watch-page:corrupt", orderKey: "za" });
    // "ir" is the first key a two-row spread generates; an archived row
    // holds it, so the respread must generate extras and skip reserved keys.
    yield* insertPageRow({
      pageId: "watch-page:archived",
      orderKey: "ir",
      archivedAt: "2025-01-02T00:00:00.000Z",
    });

    const moverId = WatchPageId.make("watch-page:mover");
    const corruptId = WatchPageId.make("watch-page:corrupt");
    yield* watch.reorder({ pageId: moverId, beforePageId: corruptId });

    const live = yield* watch.list({});
    assert.deepEqual(
      live.pages.map((page) => page.id),
      [moverId, corruptId],
    );
    assert.isFalse(live.pages.some((page) => page.orderKey === "ir"));
    const keys = yield* allOrderKeys;
    assert.equal(new Set(keys).size, keys.length);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a stale layout write with a revision conflict", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* createPage("Page");
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });

    const laidOut = yield* watch.setLayout({
      pageId: page.id,
      expectedRevision: page.revision + 1,
      layouts: [{ widgetId: widget.id, placement: { x: 0, y: 0, w: 4, h: 4 } }],
    });
    assert.equal(laidOut.widgets[0]?.placement.w, 4);

    // A second writer holding the pre-update revision is rejected, not applied.
    const stale = yield* watch
      .setLayout({
        pageId: page.id,
        expectedRevision: page.revision + 1,
        layouts: [{ widgetId: widget.id, placement: { x: 4, y: 0, w: 4, h: 4 } }],
      })
      .pipe(Effect.flip);
    assert.instanceOf(stale, WatchPageRevisionConflictError);
    assert.equal(stale.expectedRevision, page.revision + 1);
    assert.equal(stale.currentRevision, page.revision + 2);

    const after = yield* watch.list({});
    assert.equal(after.widgets.find((w) => w.id === widget.id)?.placement.x, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects overlapping placements and out-of-bounds drops", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* createPage("Page");
    yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const pageNow = (yield* watch.list({})).pages[0]!;

    const overlap = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "needs-attention",
        placement: { x: 4, y: 2, w: 4, h: 4 },
      })
      .pipe(Effect.flip);
    assert.instanceOf(overlap, WatchLayoutCollisionError);

    const outOfBounds = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "needs-attention",
        placement: { x: 10, y: 0, w: 4, h: 2 },
      })
      .pipe(Effect.flip);
    assert.instanceOf(outOfBounds, WatchLayoutCollisionError);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mobile projection writes cannot touch or conflict with desktop layout", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* createPage("Page");
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const before = (yield* watch.list({})).pages[0]!;

    const projected = yield* watch.setMobileProjection({
      pageId: page.id,
      expectedMobileRevision: before.mobileRevision,
      widgets: [{ widgetId: widget.id, mobileOrder: 0, mobileHidden: true }],
    });
    // Mobile fields changed; desktop revision and placement are untouched.
    assert.equal(projected.page.revision, before.revision);
    assert.isTrue(projected.page.mobileRevision > before.mobileRevision);
    assert.equal(projected.widgets[0]?.mobileOrder, 0);
    assert.isTrue(projected.widgets[0]?.mobileHidden === true);
    assert.equal(projected.widgets[0]?.placement.w, 6);

    // A mobile write checked against the layout revision misses — the
    // projections share no revision.
    const wrongRevision = yield* watch
      .setMobileProjection({
        pageId: page.id,
        expectedMobileRevision: before.mobileRevision,
        widgets: [{ widgetId: widget.id, mobileOrder: 0, mobileHidden: false }],
      })
      .pipe(Effect.flip);
    assert.instanceOf(wrongRevision, WatchPageRevisionConflictError);
    assert.isTrue(wrongRevision.mobileProjection === true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moveToPage checks and bumps both page revisions", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page: source } = yield* createPage("Source");
    const { page: destination } = yield* createPage("Destination");
    const { widget } = yield* watch.addWidget({
      pageId: source.id,
      expectedRevision: source.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const pages = yield* watch.list({});
    const sourceNow = pages.pages.find((page) => page.id === source.id)!;
    const destinationNow = pages.pages.find((page) => page.id === destination.id)!;

    // A stale destination revision rejects the whole move inside the same
    // transaction: the widget stays put and neither revision moves.
    const rejected = yield* watch
      .moveToPage({
        widgetId: widget.id,
        sourcePageId: source.id,
        sourceExpectedRevision: sourceNow.revision,
        destinationPageId: destination.id,
        destinationExpectedRevision: destinationNow.revision + 9,
        placement: { x: 0, y: 0, w: 6, h: 4 },
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, WatchPageRevisionConflictError);
    const unchanged = yield* watch.list({});
    assert.equal(unchanged.widgets.find((w) => w.id === widget.id)?.pageId, source.id);
    assert.equal(unchanged.pages.find((p) => p.id === source.id)?.revision, sourceNow.revision);
    assert.equal(
      unchanged.pages.find((p) => p.id === destination.id)?.revision,
      destinationNow.revision,
    );

    const moved = yield* watch.moveToPage({
      widgetId: widget.id,
      sourcePageId: source.id,
      sourceExpectedRevision: sourceNow.revision,
      destinationPageId: destination.id,
      destinationExpectedRevision: destinationNow.revision,
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    assert.equal(moved.widget.pageId, destination.id);
    const after = yield* watch.list({});
    assert.isTrue(
      (after.pages.find((p) => p.id === source.id)?.revision ?? 0) > sourceNow.revision,
    );
    assert.isTrue(
      (after.pages.find((p) => p.id === destination.id)?.revision ?? 0) > destinationNow.revision,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moveToPage onto the same page is a no-op", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* createPage("Page");
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const before = (yield* watch.list({})).pages[0]!;

    // Without the early return the two revision bumps both hit this one row
    // and the second reports a phantom conflict on a revision that never
    // committed.
    const moved = yield* watch.moveToPage({
      widgetId: widget.id,
      sourcePageId: page.id,
      sourceExpectedRevision: before.revision,
      destinationPageId: page.id,
      destinationExpectedRevision: before.revision,
      placement: { x: 6, y: 0, w: 6, h: 4 },
    });
    assert.equal(moved.widget.pageId, page.id);
    assert.equal(moved.widget.placement.x, 0);

    const after = (yield* watch.list({})).pages[0]!;
    assert.equal(after.revision, before.revision);
    assert.equal(after.mobileRevision, before.mobileRevision);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("widget config edits check the widget revision, not the page's", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* createPage("Page");
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      config: { source: { kind: "threads" } },
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const configured = yield* watch.configureWidget({
      widgetId: widget.id,
      expectedRevision: widget.revision,
      config: { source: { kind: "threads", binding: "project:one" } },
    });
    assert.isTrue(configured.widget.revision > widget.revision);
    assert.equal(configured.widget.config.source?.binding, "project:one");

    const stale = yield* watch
      .configureWidget({
        widgetId: widget.id,
        expectedRevision: widget.revision,
        config: { source: { kind: "static" } },
      })
      .pipe(Effect.flip);
    assert.instanceOf(stale, WatchPageRevisionConflictError);
    assert.equal(stale.widgetId, widget.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pack provenance requires a live pack-registered widget source", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const sql = yield* SqlClient.SqlClient;
    const { page } = yield* createPage("Page");

    // Registration the install flow writes: one live pack version and the
    // `agent:<sourceId>` kind its bundled widget transpiled into.
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
        source_id: "watch-widget-source:abc",
        created_at: "2025-01-01T00:00:00.000Z",
      })}
    `;
    // A soft-archived pack keeps its registrations on record but mounts nothing.
    yield* sql`
      INSERT INTO watch_connector_packs ${sql.insert({
        pack_id: "pack.gone",
        schema_version: 1,
        manifest_json: "{}",
        manifest_hash: "manifest-hash",
        origin_json: "{}",
        content_hash: "content-hash",
        approved_at: "2025-01-01T00:00:00.000Z",
        archived_at: "2025-01-02T00:00:00.000Z",
      })}
    `;
    yield* sql`
      INSERT INTO watch_pack_widget_sources ${sql.insert({
        pack_id: "pack.gone",
        schema_version: 1,
        name: "gone-chart",
        file: "widgets/gone.tsx",
        source_id: "watch-widget-source:gone",
        created_at: "2025-01-01T00:00:00.000Z",
      })}
    `;

    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "agent:watch-widget-source:abc",
      provenance: "pack:pack.test",
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    assert.equal(widget.provenance, "pack:pack.test");

    const agentDefault = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision + 1,
      kind: "agent:scratch",
      placement: { x: 6, y: 0, w: 6, h: 4 },
    });
    assert.equal(agentDefault.widget.provenance, "agentPublished");

    const pageNow = (yield* watch.list({})).pages[0]!;

    // A forged marker — the pack never registered this source id — is refused.
    const forgedSource = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "agent:watch-widget-source:forged",
        provenance: "pack:pack.test",
        placement: { x: 0, y: 4, w: 4, h: 4 },
      })
      .pipe(Effect.flip);
    assert.equal(forgedSource._tag, "WatchPageError");

    // So is a registered source claimed under a pack that did not ship it.
    const forgedPack = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "agent:watch-widget-source:abc",
        provenance: "pack:pack.other",
        placement: { x: 4, y: 4, w: 4, h: 4 },
      })
      .pipe(Effect.flip);
    assert.equal(forgedPack._tag, "WatchPageError");

    // An uninstalled pack's sources cannot be freshly mounted either.
    const archivedPack = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "agent:watch-widget-source:gone",
        provenance: "pack:pack.gone",
        placement: { x: 8, y: 4, w: 4, h: 4 },
      })
      .pipe(Effect.flip);
    assert.equal(archivedPack._tag, "WatchPageError");

    // pack: provenance on a first-party kind is still rejected outright.
    const rejected = yield* watch
      .addWidget({
        pageId: page.id,
        expectedRevision: pageNow.revision,
        kind: "active-work",
        provenance: "pack:pack.test",
        placement: { x: 0, y: 8, w: 4, h: 4 },
      })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "WatchPageError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gallery instantiate creates real rows and is repeatable after delete", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const gallery = yield* watch.listGallery();
    const template = gallery.templates[0]!;
    assert.isTrue(template.widgets.length > 0);

    const first = yield* watch.instantiateFromGallery({ templateId: template.id });
    assert.equal(first.page.name, template.name);
    assert.equal(first.widgets.length, template.widgets.length);
    assert.isTrue(first.widgets.every((widget) => widget.provenance === "firstParty"));

    yield* watch.delete({ pageId: first.page.id });
    const second = yield* watch.instantiateFromGallery({ templateId: template.id });
    assert.notEqual(second.page.id, first.page.id);
    assert.equal(second.widgets.length, template.widgets.length);

    const missing = yield* watch
      .instantiateFromGallery({ templateId: "no-such-template" })
      .pipe(Effect.flip);
    assert.equal(missing._tag, "WatchPageError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subscribeList emits a snapshot and re-emits after every change", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    yield* createPage("One");

    const firstSeen = yield* Deferred.make<void>();
    const fiber = yield* watch.subscribeList({}).pipe(
      Stream.tap(() => Deferred.succeed(firstSeen, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(firstSeen);
    yield* createPage("Two");
    const emissions = yield* Fiber.join(fiber);
    assert.equal(emissions.length, 2);
    assert.equal(emissions[0]?.pages.length, 1);
    assert.equal(emissions[1]?.pages.length, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("archives project-scoped pages and keeps them out of the default list", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const projectId = ProjectId.make("project:watch-archive");
    const { page } = yield* watch.create({
      name: "Scoped",
      scope: "project",
      projectId,
    });
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      config: { source: { kind: "threads" } },
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    yield* watch.archiveForProject(projectId);

    const active = yield* watch.list({});
    assert.equal(active.pages.length, 0);
    const withArchived = yield* watch.list({ includeArchived: true });
    assert.equal(withArchived.pages.length, 1);
    assert.isNotNull(withArchived.pages[0]?.archivedAt);

    // Archived pages are immutable: a layout write reports the archive, not a
    // revision conflict.
    const write = yield* watch
      .setLayout({
        pageId: page.id,
        expectedRevision: page.revision,
        layouts: [],
      })
      .pipe(Effect.flip);
    assert.equal(write._tag, "WatchPageError");

    // Config writes are gated the same way — a queued write cannot land on a
    // parked page and resurrect with it on restore.
    const configWrite = yield* watch
      .configureWidget({
        widgetId: widget.id,
        expectedRevision: widget.revision,
        config: { source: { kind: "static" } },
      })
      .pipe(Effect.flip);
    assert.equal(configWrite._tag, "WatchPageError");
    const restoredWidget = (yield* watch.list({ includeArchived: true })).widgets.find(
      (entry) => entry.id === widget.id,
    );
    assert.equal(restoredWidget?.config.source?.kind, "threads");

    // Archiving is idempotent and scoped to the project.
    yield* watch.archiveForProject(projectId);
    assert.equal((yield* watch.list({ includeArchived: true })).pages.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("restores an archived page with a revision bump", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const projectId = ProjectId.make("project:watch-restore");
    const { page } = yield* watch.create({ name: "Scoped", scope: "project", projectId });
    yield* watch.archiveForProject(projectId);

    // Restoring a live page is an error, not a silent no-op.
    const { page: live } = yield* createPage("Live");
    const notArchived = yield* watch.restore({ pageId: live.id }).pipe(Effect.flip);
    assert.equal(notArchived._tag, "WatchPageError");

    const restored = yield* watch.restore({ pageId: page.id });
    assert.isNull(restored.page.archivedAt);
    assert.isTrue(restored.page.revision > page.revision);
    // Both revisions bump: a mobile projection writer holding the
    // pre-archive revision invalidates the same way a stale layout write does.
    assert.isTrue(restored.page.mobileRevision > page.mobileRevision);
    const staleMobile = yield* watch
      .setMobileProjection({
        pageId: page.id,
        expectedMobileRevision: page.mobileRevision,
        widgets: [],
      })
      .pipe(Effect.flip);
    assert.instanceOf(staleMobile, WatchPageRevisionConflictError);
    // Scope and binding survive the archive round-trip untouched.
    assert.equal(restored.page.scope, "project");
    assert.equal(restored.page.projectId, projectId);

    const active = yield* watch.list({});
    assert.deepEqual(
      active.pages.map((entry) => entry.id),
      [page.id, live.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rescope writes only the page row and refuses archived pages", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const projectA = ProjectId.make("project:watch-rescope-a");
    const projectB = ProjectId.make("project:watch-rescope-b");
    const { page } = yield* watch.create({ name: "Board" });
    const { widget: unbound } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "active-work",
      config: { source: { kind: "threads" } },
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    const { widget: bound } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision + 1,
      kind: "needs-attention",
      config: { source: { kind: "threads", binding: projectB } },
      placement: { x: 6, y: 0, w: 6, h: 4 },
    });

    const scoped = yield* watch.updateScope({
      pageId: page.id,
      scope: "project",
      projectId: projectA,
    });
    assert.equal(scoped.page.scope, "project");
    assert.equal(scoped.page.projectId, projectA);
    assert.isTrue(scoped.page.revision > page.revision + 2);

    // The rescope writes no widget rows: the unbound widget still carries no
    // binding so it now resolves against projectA, and the explicit binding
    // to projectB is preserved.
    const listed = yield* watch.list({});
    const stored = (id: typeof unbound.id) => listed.widgets.find((w) => w.id === id);
    assert.isUndefined(stored(unbound.id)?.config.source?.binding);
    assert.equal(stored(bound.id)?.config.source?.binding, projectB);

    const globalAgain = yield* watch.updateScope({ pageId: page.id, scope: "global" });
    assert.equal(globalAgain.page.scope, "global");
    assert.isNull(globalAgain.page.projectId);

    const missingProject = yield* watch
      .updateScope({ pageId: page.id, scope: "project" })
      .pipe(Effect.flip);
    assert.equal(missingProject._tag, "WatchPageError");

    const { page: scopedPage } = yield* watch.updateScope({
      pageId: page.id,
      scope: "project",
      projectId: projectA,
    });
    yield* watch.archiveForProject(projectA);
    const archivedWrite = yield* watch
      .updateScope({ pageId: page.id, scope: "global" })
      .pipe(Effect.flip);
    assert.equal(archivedWrite._tag, "WatchPageError");

    // Restore-then-rescope is the recovery path for a deleted project.
    yield* watch.restore({ pageId: scopedPage.id });
    const rescued = yield* watch.updateScope({
      pageId: page.id,
      scope: "project",
      projectId: projectB,
    });
    assert.equal(rescued.page.projectId, projectB);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deleting a project soft-archives its watch pages", () =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const projects = yield* ProjectService.ProjectService;
    const projectId = ProjectId.make("project:watch-cascade");
    yield* projects.create({
      commandId: CommandId.make("command:watch:project-create"),
      projectId,
      title: "Watch project",
      workspaceRoot: "/work/watch-cascade/",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex_custom"),
        model: "gpt-5.1-codex",
      },
    });
    const { page } = yield* watch.create({
      name: "Scoped",
      scope: "project",
      projectId,
    });
    const { page: globalPage } = yield* watch.create({ name: "Global" });

    yield* projects.delete({
      commandId: CommandId.make("command:watch:project-delete"),
      projectId,
    });

    const listed = yield* watch.list({});
    assert.deepEqual(
      listed.pages.map((entry) => entry.id),
      [globalPage.id],
    );
    const withArchived = yield* watch.list({ includeArchived: true });
    assert.equal(withArchived.pages.length, 2);
    assert.isNotNull(withArchived.pages.find((entry) => entry.id === page.id)?.archivedAt);
    // The global page is untouched.
    assert.isNull(withArchived.pages.find((entry) => entry.id === globalPage.id)?.archivedAt);
  }).pipe(Effect.provide(layerProjectDelete)),
);

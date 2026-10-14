import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  WatchLayoutCollisionError,
  WatchPageRevisionConflictError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

    // Archiving is idempotent and scoped to the project.
    yield* watch.archiveForProject(projectId);
    assert.equal((yield* watch.list({ includeArchived: true })).pages.length, 1);
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

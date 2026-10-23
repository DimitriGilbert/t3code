import {
  type ProjectId,
  WatchLayoutCollisionError,
  WatchPage,
  WatchPageError,
  type WatchPageCreateInput,
  type WatchPageDeleteInput,
  type WatchPageDeleteResult,
  type WatchPageDuplicateInput,
  type WatchPageInstantiateFromGalleryInput,
  WatchPageId,
  type WatchPageListInput,
  type WatchPageListResult,
  type WatchPageRenameInput,
  type WatchPageReorderInput,
  type WatchPageRestoreInput,
  type WatchPageResult,
  WatchPageRevisionConflictError,
  type WatchPageUpdateScopeInput,
  type WatchPageWithWidgetsResult,
  WatchWidget,
  type WatchWidgetAddInput,
  type WatchWidgetConfigureInput,
  WatchWidgetId,
  type WatchWidgetMoveToPageInput,
  type WatchWidgetPlacement,
  type WatchWidgetProvenance,
  WatchWidgetConfig,
  type WatchWidgetRemoveInput,
  type WatchWidgetRemoveResult,
  type WatchWidgetResult,
  type WatchWidgetSetLayoutInput,
  type WatchWidgetSetMobileProjectionInput,
  type WatchGalleryListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { WATCH_GALLERY_TEMPLATES } from "./gallery.ts";

export class WatchPageService extends Context.Service<
  WatchPageService,
  {
    readonly list: (
      input: WatchPageListInput,
    ) => Effect.Effect<WatchPageListResult, WatchPageError>;
    /** Emits the full page+widget list on subscribe and again after every change. */
    readonly subscribeList: (
      input: WatchPageListInput,
    ) => Stream.Stream<WatchPageListResult, WatchPageError>;
    readonly listGallery: () => Effect.Effect<WatchGalleryListResult>;
    readonly create: (
      input: WatchPageCreateInput,
    ) => Effect.Effect<WatchPageResult, WatchPageError>;
    readonly rename: (
      input: WatchPageRenameInput,
    ) => Effect.Effect<WatchPageResult, WatchPageError>;
    readonly reorder: (
      input: WatchPageReorderInput,
    ) => Effect.Effect<WatchPageResult, WatchPageError>;
    readonly duplicate: (
      input: WatchPageDuplicateInput,
    ) => Effect.Effect<WatchPageWithWidgetsResult, WatchPageError>;
    readonly delete: (
      input: WatchPageDeleteInput,
    ) => Effect.Effect<WatchPageDeleteResult, WatchPageError>;
    /**
     * Un-archives a page parked by a project delete. The page keeps its
     * original scope and projectId — when the project is gone for good the
     * user rescopes it with `updateScope`.
     */
    readonly restore: (
      input: WatchPageRestoreInput,
    ) => Effect.Effect<WatchPageResult, WatchPageError>;
    /**
     * Moves a page between `global` and `project` scope. Widget rows are
     * untouched: unbound widgets still carry no binding and resolve against
     * the new ambient project at read time; explicit `source.binding` values
     * keep pointing where the user put them.
     */
    readonly updateScope: (
      input: WatchPageUpdateScopeInput,
    ) => Effect.Effect<WatchPageResult, WatchPageError>;
    /** Instantiates a gallery template into a real page; repeatable — never a seeded row. */
    readonly instantiateFromGallery: (
      input: WatchPageInstantiateFromGalleryInput,
    ) => Effect.Effect<WatchPageWithWidgetsResult, WatchPageError>;
    /**
     * Soft-archives every page bound to a deleted project. Widget rows are
     * kept so their bindings degrade to the "project missing" widget state.
     */
    readonly archiveForProject: (projectId: ProjectId) => Effect.Effect<void, WatchPageError>;
    readonly addWidget: (
      input: WatchWidgetAddInput,
    ) => Effect.Effect<
      WatchWidgetResult,
      WatchPageError | WatchPageRevisionConflictError | WatchLayoutCollisionError
    >;
    readonly removeWidget: (
      input: WatchWidgetRemoveInput,
    ) => Effect.Effect<WatchWidgetRemoveResult, WatchPageError | WatchPageRevisionConflictError>;
    /** Config-only edit; checked against the widget's own revision. */
    readonly configureWidget: (
      input: WatchWidgetConfigureInput,
    ) => Effect.Effect<WatchWidgetResult, WatchPageError | WatchPageRevisionConflictError>;
    /** Desktop grid write; checked against the page revision, collisions rejected. */
    readonly setLayout: (
      input: WatchWidgetSetLayoutInput,
    ) => Effect.Effect<
      WatchPageWithWidgetsResult,
      WatchPageError | WatchPageRevisionConflictError | WatchLayoutCollisionError
    >;
    /**
     * Writes only `mobileOrder`/`mobileHidden` under the page's
     * `mobileRevision` — it can never touch or conflict with desktop layout.
     */
    readonly setMobileProjection: (
      input: WatchWidgetSetMobileProjectionInput,
    ) => Effect.Effect<WatchPageWithWidgetsResult, WatchPageError | WatchPageRevisionConflictError>;
    /** Moves one widget between pages; a stale revision on either page rejects the whole move. */
    readonly moveToPage: (
      input: WatchWidgetMoveToPageInput,
    ) => Effect.Effect<
      WatchWidgetResult,
      WatchPageError | WatchPageRevisionConflictError | WatchLayoutCollisionError
    >;
  }
>()("t3/watch/WatchPageService") {}

function watchError(
  message: string,
  input?: { pageId?: WatchPageId; widgetId?: WatchWidgetId; cause?: unknown },
) {
  return new WatchPageError({
    message,
    ...(input?.pageId === undefined ? {} : { pageId: input.pageId }),
    ...(input?.widgetId === undefined ? {} : { widgetId: input.widgetId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

// ── Fractional order keys ────────────────────────────────────────────────
// Same base-26 keyspace as client-runtime's pinOrderKeyBetween (threadSort.ts),
// so server-generated keys interleave correctly with client-generated ones.

const ORDER_KEY_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!ORDER_KEY_DIGITS.includes(char)) return false;
  }
  return key.at(-1) !== ORDER_KEY_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1). */
function orderKeyMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("orderKeyMidpoint: bounds out of order");
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || ORDER_KEY_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + orderKeyMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : ORDER_KEY_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? ORDER_KEY_DIGITS.length : ORDER_KEY_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return ORDER_KEY_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  if (b.length > 1) return b.charAt(0);
  return ORDER_KEY_DIGITS.charAt(digitA) + orderKeyMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null means a bound is corrupt. */
function orderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidOrderKey(a)) return null;
  if (b !== "" && !isValidOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return orderKeyMidpoint(a, b);
}

/** Evenly spaced keys for materializing an order when a neighbor key is corrupt. */
function spreadOrderKeys(count: number): ReadonlyArray<string> {
  let width = 2;
  let space = ORDER_KEY_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= ORDER_KEY_DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % ORDER_KEY_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = ORDER_KEY_DIGITS.charAt(value % ORDER_KEY_DIGITS.length) + key;
      value = Math.floor(value / ORDER_KEY_DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

/** Key sorting strictly after `last` — an extension always outranks its prefix. */
const orderKeyAfter = (last: string) => `${last}n`;

/**
 * `orderKeyBetween` that steps past keys held by rows outside the rewrite
 * set — archived pages keep their keys, so a minted key landing on one
 * collides in the `order_key` ordering. Each retry mints closer to `after`,
 * so the reserved set can only be hit finitely many times. Mirrors the
 * client-side `planPinnedReorder` reserved-keys loop (threadSort.ts).
 */
const orderKeyBetweenUnreserved = (
  before: string | null,
  after: string | null,
  reserved: ReadonlySet<string>,
): string | null => {
  let key = orderKeyBetween(before, after);
  while (key !== null && reserved.has(key)) key = orderKeyBetween(key, after);
  return key;
};

/** `spreadOrderKeys` that skips reserved keys; the extra slots absorb the removals. */
const spreadOrderKeysUnreserved = (
  count: number,
  reserved: ReadonlySet<string>,
): ReadonlyArray<string> =>
  spreadOrderKeys(count + reserved.size)
    .filter((key) => !reserved.has(key))
    .slice(0, count);

// ── Layout geometry ──────────────────────────────────────────────────────

const GRID_COLUMNS = 12;

const placementInBounds = (placement: WatchWidgetPlacement): boolean =>
  placement.x >= 0 &&
  placement.y >= 0 &&
  placement.w >= 1 &&
  placement.h >= 1 &&
  placement.x + placement.w <= GRID_COLUMNS &&
  (placement.minCols === undefined || (placement.minCols >= 1 && placement.minCols <= placement.w));

const placementsOverlap = (a: WatchWidgetPlacement, b: WatchWidgetPlacement): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** First out-of-bounds or overlapping widget pair; null when the layout is clean. */
function findLayoutConflict(
  placements: ReadonlyArray<{ id: WatchWidgetId; placement: WatchWidgetPlacement }>,
): { widgetIds: ReadonlyArray<WatchWidgetId>; message: string } | null {
  for (const { id, placement } of placements) {
    if (!placementInBounds(placement)) {
      return {
        widgetIds: [id],
        message: "Widget placement is outside the 12-column grid.",
      };
    }
  }
  for (let i = 0; i < placements.length; i += 1) {
    const left = placements[i]!;
    for (let j = i + 1; j < placements.length; j += 1) {
      const right = placements[j]!;
      if (placementsOverlap(left.placement, right.placement)) {
        return {
          widgetIds: [left.id, right.id],
          message: "Widget placements overlap.",
        };
      }
    }
  }
  return null;
}

// ── Rows ─────────────────────────────────────────────────────────────────

interface WatchPageRow {
  readonly page_id: string;
  readonly name: string;
  readonly scope: string;
  readonly project_id: string | null;
  readonly order_key: string;
  readonly revision: number;
  readonly mobile_revision: number;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WatchWidgetRow {
  readonly widget_id: string;
  readonly page_id: string;
  readonly kind: string;
  readonly config_json: string;
  readonly placement_x: number;
  readonly placement_y: number;
  readonly placement_w: number;
  readonly placement_h: number;
  readonly placement_min_cols: number | null;
  readonly revision: number;
  readonly mobile_order: number;
  readonly mobile_hidden: number;
  readonly provenance: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodePage = Schema.decodeUnknownEffect(WatchPage);
const decodeWidget = Schema.decodeUnknownEffect(WatchWidget);
const WidgetConfigJson = Schema.fromJsonString(WatchWidgetConfig);
const decodeWidgetConfigJson = Schema.decodeUnknownEffect(WidgetConfigJson);
const encodeWidgetConfigJson = Schema.encodeSync(WidgetConfigJson);
const isWatchPageError = Schema.is(WatchPageError);
const isWatchPageRevisionConflictError = Schema.is(WatchPageRevisionConflictError);
const isWatchLayoutCollisionError = Schema.is(WatchLayoutCollisionError);
/** Already a typed watch error; re-fail it instead of re-wrapping in `WatchPageError`. */
const isTypedWatchError = (
  cause: unknown,
): cause is WatchPageError | WatchPageRevisionConflictError | WatchLayoutCollisionError =>
  isWatchPageError(cause) ||
  isWatchPageRevisionConflictError(cause) ||
  isWatchLayoutCollisionError(cause);

const PAGE_COLUMNS = `page_id, name, scope, project_id, order_key, revision, mobile_revision, archived_at, created_at, updated_at`;
const WIDGET_COLUMNS = `widget_id, page_id, kind, config_json, placement_x, placement_y, placement_w, placement_h, placement_min_cols, revision, mobile_order, mobile_hidden, provenance, created_at, updated_at`;

const decodePageRow = (row: WatchPageRow) =>
  decodePage({
    id: row.page_id,
    name: row.name,
    scope: row.scope,
    projectId: row.project_id,
    orderKey: row.order_key,
    revision: row.revision,
    mobileRevision: row.mobile_revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const decodeWidgetRow = (row: WatchWidgetRow) =>
  decodeWidgetConfigJson(row.config_json).pipe(
    Effect.flatMap((config) =>
      decodeWidget({
        id: row.widget_id,
        pageId: row.page_id,
        kind: row.kind,
        config,
        placement: {
          x: row.placement_x,
          y: row.placement_y,
          w: row.placement_w,
          h: row.placement_h,
          ...(row.placement_min_cols === null ? {} : { minCols: row.placement_min_cols }),
        },
        revision: row.revision,
        mobileOrder: row.mobile_order,
        mobileHidden: row.mobile_hidden === 1,
        provenance: row.provenance,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    ),
  );

const provenanceForKind = (kind: string): WatchWidgetProvenance =>
  kind.startsWith("agent:") ? "agentPublished" : "firstParty";

/**
 * Pack-provided widgets are `agent:`-kind widgets whose source shipped inside
 * a connector pack, so the pack install flow marks them `pack:<packId>` —
 * provenance a kind alone cannot express. The marker is accepted only on
 * `agent:` kinds; anything else would mislabel first-party chrome.
 */
const provenanceForAdd = (
  kind: string,
  provenance: `pack:${string}` | undefined,
): WatchWidgetProvenance | "invalid" => {
  if (provenance === undefined) return provenanceForKind(kind);
  return kind.startsWith("agent:") ? provenance : "invalid";
};

export const layer = Layer.effect(
  WatchPageService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const newPageId = crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => WatchPageId.make(`watch-page:${uuid}`)),
      Effect.mapError((cause) => watchError("Could not generate watch page id.", { cause })),
    );
    const newWidgetId = crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => WatchWidgetId.make(`watch-widget:${uuid}`)),
      Effect.mapError((cause) => watchError("Could not generate watch widget id.", { cause })),
    );

    const selectPageRows = (options: { readonly includeArchived: boolean }) =>
      sql<WatchPageRow>`
        SELECT ${sql.literal(PAGE_COLUMNS)}
        FROM watch_pages
        WHERE ${sql.and(options.includeArchived ? [] : [sql`archived_at IS NULL`])}
        ORDER BY order_key ASC, page_id ASC
      `;

    const selectWidgetRows = (pageIds: ReadonlyArray<WatchPageId>) =>
      sql<WatchWidgetRow>`
        SELECT ${sql.literal(WIDGET_COLUMNS)}
        FROM watch_widgets
        WHERE page_id IN ${sql.in(pageIds)}
        ORDER BY created_at ASC, widget_id ASC
      `;

    const loadPageRows = (pageId: WatchPageId) =>
      sql<WatchPageRow>`
        SELECT ${sql.literal(PAGE_COLUMNS)} FROM watch_pages WHERE page_id = ${pageId}
      `;

    const loadWidgetRowsForPage = (pageId: WatchPageId) =>
      sql<WatchWidgetRow>`
        SELECT ${sql.literal(WIDGET_COLUMNS)} FROM watch_widgets WHERE page_id = ${pageId}
      `;

    /** Load a page, returning `null` when it does not exist; load/decode failures propagate. */
    const findPage = (pageId: WatchPageId) =>
      loadPageRows(pageId).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodePageRow(rows[0]),
        ),
        Effect.mapError((cause) => watchError("Could not load watch page.", { pageId, cause })),
      );

    const findWidget = (widgetId: WatchWidgetId) =>
      sql<WatchWidgetRow>`
        SELECT ${sql.literal(WIDGET_COLUMNS)} FROM watch_widgets WHERE widget_id = ${widgetId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeWidgetRow(rows[0]),
        ),
        Effect.mapError((cause) => watchError("Could not load watch widget.", { widgetId, cause })),
      );

    const widgetsForPage = (pageId: WatchPageId) =>
      loadWidgetRowsForPage(pageId).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodeWidgetRow, { concurrency: 1 })),
        Effect.mapError((cause) => watchError("Could not load watch widgets.", { pageId, cause })),
      );

    /**
     * Why a revision-checked write matched no row: the page is missing,
     * archived, or the caller's revision is stale. Runs inside the caller's
     * transaction so it sees the same snapshot.
     */
    const failRevisionMiss = Effect.fn("WatchPageService.failRevisionMiss")(function* (
      pageId: WatchPageId,
      expectedRevision: number,
      mobileProjection: boolean,
    ) {
      const page = yield* findPage(pageId);
      if (page === null) {
        return yield* watchError("Watch page not found.", { pageId });
      }
      if (page.archivedAt !== null) {
        return yield* watchError("Watch page is archived.", { pageId });
      }
      const currentRevision = mobileProjection ? page.mobileRevision : page.revision;
      return yield* new WatchPageRevisionConflictError({
        pageId,
        ...(mobileProjection ? { mobileProjection: true } : {}),
        expectedRevision,
        currentRevision,
        message: `Watch page ${mobileProjection ? "mobile projection " : ""}changed since revision ${expectedRevision}; reload and retry.`,
      });
    });

    /** Bumps the page layout revision under its expected value; also bumps the mobile revision when membership changed. */
    const bumpPageRevision = Effect.fn("WatchPageService.bumpPageRevision")(function* (
      pageId: WatchPageId,
      expectedRevision: number,
      nowIso: string,
      options: { readonly bumpMobile: boolean },
    ) {
      const rows = yield* options.bumpMobile
        ? sql<{ page_id: string }>`
            UPDATE watch_pages
            SET revision = revision + 1,
                mobile_revision = mobile_revision + 1,
                updated_at = ${nowIso}
            WHERE page_id = ${pageId} AND revision = ${expectedRevision} AND archived_at IS NULL
            RETURNING page_id
          `
        : sql<{ page_id: string }>`
            UPDATE watch_pages
            SET revision = revision + 1,
                updated_at = ${nowIso}
            WHERE page_id = ${pageId} AND revision = ${expectedRevision} AND archived_at IS NULL
            RETURNING page_id
          `;
      if (rows.length > 0) return;
      return yield* failRevisionMiss(pageId, expectedRevision, false);
    });

    /** Bumps only the mobile projection revision — desktop layout fields are untouched. */
    const bumpMobileRevision = Effect.fn("WatchPageService.bumpMobileRevision")(function* (
      pageId: WatchPageId,
      expectedMobileRevision: number,
      nowIso: string,
    ) {
      const rows = yield* sql<{ page_id: string }>`
        UPDATE watch_pages
        SET mobile_revision = mobile_revision + 1,
            updated_at = ${nowIso}
        WHERE page_id = ${pageId} AND mobile_revision = ${expectedMobileRevision} AND archived_at IS NULL
        RETURNING page_id
      `;
      if (rows.length > 0) return;
      return yield* failRevisionMiss(pageId, expectedMobileRevision, true);
    });

    const pageWithWidgets = (pageId: WatchPageId) =>
      Effect.gen(function* () {
        const page = yield* findPage(pageId);
        if (page === null) {
          return yield* watchError("Watch page not found.", { pageId });
        }
        const widgets = yield* widgetsForPage(pageId);
        return { page, widgets };
      });

    // Archived rows count toward the max: a page created while the max-keyed
    // page is archived must still append after it, or restoring that page
    // lands two rows on one key and ordering falls to arbitrary page_id.
    const lastOrderKey = Effect.gen(function* () {
      const rows = yield* sql<{ order_key: string }>`
        SELECT order_key FROM watch_pages
        ORDER BY order_key DESC, page_id DESC
        LIMIT 1
      `;
      return rows[0]?.order_key ?? null;
    });

    /**
     * Keys archived rows still hold. Reorder/duplicate mint keys against the
     * live set only, so without reserving these a new key can collide with a
     * parked row — and a later restore lands two pages on one key.
     */
    const archivedOrderKeys = (afterKey?: string) =>
      sql<{ order_key: string }>`
        SELECT order_key FROM watch_pages
        WHERE ${sql.and([
          sql`archived_at IS NOT NULL`,
          ...(afterKey === undefined ? [] : [sql`order_key > ${afterKey}`]),
        ])}
      `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.order_key))));

    /**
     * A `pack:` marker renders as "installed by connector pack X" chrome, so
     * it is only written when the pack actually registered this widget kind's
     * source — a caller cannot mint the badge for an arbitrary `agent:` kind.
     * The join through `watch_connector_packs` follows
     * `ConnectorService.selectWidgetSourceRows`: an archived pack's sources
     * are not live, so they cannot be freshly mounted under `pack:` either.
     */
    const assertPackProvenance = (
      pageId: WatchPageId,
      kind: string,
      provenance: `pack:${string}`,
    ) =>
      Effect.gen(function* () {
        const packId = provenance.slice("pack:".length);
        const sourceId = kind.slice("agent:".length);
        const rows = yield* sql<{ source_id: string }>`
          SELECT s.source_id
          FROM watch_pack_widget_sources s
          JOIN watch_connector_packs p
            ON p.pack_id = s.pack_id AND p.schema_version = s.schema_version
          WHERE s.pack_id = ${packId}
            AND s.source_id = ${sourceId}
            AND p.archived_at IS NULL
          LIMIT 1
        `;
        if (rows.length === 0) {
          return yield* watchError(
            `Pack provenance "${provenance}" does not match a live widget source registered for "${kind}".`,
            { pageId },
          );
        }
      });

    const list: WatchPageService["Service"]["list"] = (input) =>
      Effect.gen(function* () {
        const includeArchived = input.includeArchived === true;
        const pageRows = yield* selectPageRows({ includeArchived });
        const pages = yield* Effect.forEach(pageRows, decodePageRow, { concurrency: 1 });
        const pageIds = pages.map((page) => page.id);
        const widgets =
          pageIds.length === 0
            ? []
            : yield* selectWidgetRows(pageIds).pipe(
                Effect.flatMap((rows) => Effect.forEach(rows, decodeWidgetRow, { concurrency: 1 })),
              );
        return { pages, widgets };
      }).pipe(Effect.mapError((cause) => watchError("Could not list watch pages.", { cause })));

    const subscribeList: WatchPageService["Service"]["subscribeList"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      );

    const listGallery: WatchPageService["Service"]["listGallery"] = () =>
      Effect.succeed({ templates: [...WATCH_GALLERY_TEMPLATES] });

    const create: WatchPageService["Service"]["create"] = (input) =>
      Effect.gen(function* () {
        const scope = input.scope ?? "global";
        const projectId = scope === "project" ? (input.projectId ?? null) : null;
        if (scope === "project" && projectId === null) {
          return yield* watchError("A project-scoped watch page requires a projectId.");
        }
        const now = yield* localNow;
        const nowIso = iso(now);
        const id = yield* newPageId;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // The max-key read and the insert share one transaction:
            // `order_key` has no UNIQUE constraint, so two concurrent
            // creates reading the same `lastKey` would mint the same key.
            const lastKey = yield* lastOrderKey;
            const orderKey = lastKey === null ? "n" : orderKeyAfter(lastKey);
            yield* insertPageRow({
              id,
              name: input.name,
              scope,
              projectId,
              orderKey,
              nowIso,
            });
          }),
        );
        const page = yield* findPage(id);
        if (page === null) {
          return yield* watchError("Watch page not found after create.", { pageId: id });
        }
        yield* notifyChanged;
        return { page };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause) ? cause : watchError("Could not create watch page.", { cause }),
        ),
      );

    const rename: WatchPageService["Service"]["rename"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        const rows = yield* sql<{ page_id: string }>`
          UPDATE watch_pages
          SET name = ${input.name},
              revision = revision + 1,
              updated_at = ${nowIso}
          WHERE page_id = ${input.pageId} AND archived_at IS NULL
          RETURNING page_id
        `;
        const page = yield* findPage(input.pageId);
        if (rows.length === 0) {
          if (page === null)
            return yield* watchError("Watch page not found.", { pageId: input.pageId });
          return yield* watchError("Watch page is archived.", { pageId: input.pageId });
        }
        if (page === null) {
          return yield* watchError("Watch page not found.", { pageId: input.pageId });
        }
        yield* notifyChanged;
        return { page };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not rename watch page.", {
                pageId: input.pageId,
                cause,
              }),
        ),
      );

    const reorder: WatchPageService["Service"]["reorder"] = (input) =>
      Effect.gen(function* () {
        if (input.beforePageId === input.pageId) {
          const page = yield* findPage(input.pageId);
          if (page === null) {
            return yield* watchError("Watch page not found.", { pageId: input.pageId });
          }
          return { page };
        }
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const pageRows = yield* selectPageRows({ includeArchived: false });
            // Archived rows keep their keys: a minted or respread key must
            // step past them or a later restore lands two pages on one key.
            const reservedKeys = yield* archivedOrderKeys();
            const pages = yield* Effect.forEach(pageRows, decodePageRow, { concurrency: 1 });
            const movedIndex = pages.findIndex((page) => page.id === input.pageId);
            if (movedIndex < 0) {
              return yield* watchError("Watch page not found.", { pageId: input.pageId });
            }
            const remaining = pages.filter((page) => page.id !== input.pageId);
            const insertIndex =
              input.beforePageId === null
                ? remaining.length
                : remaining.findIndex((page) => page.id === input.beforePageId);
            if (insertIndex < 0) {
              return yield* watchError(
                "Watch page reorder target not found.",
                input.beforePageId === null ? {} : { pageId: input.beforePageId },
              );
            }
            const previous = insertIndex === 0 ? null : remaining[insertIndex - 1]!;
            const next = insertIndex >= remaining.length ? null : remaining[insertIndex]!;
            const orderKey = orderKeyBetweenUnreserved(
              previous?.orderKey ?? null,
              next?.orderKey ?? null,
              reservedKeys,
            );
            if (orderKey !== null) {
              yield* sql`
                UPDATE watch_pages
                SET order_key = ${orderKey}, updated_at = ${nowIso}
                WHERE page_id = ${input.pageId}
              `;
            } else {
              // Corrupt neighbor keys leave no midpoint: rewrite the whole order.
              const reordered = [
                ...remaining.slice(0, insertIndex),
                pages[movedIndex]!,
                ...remaining.slice(insertIndex),
              ];
              const keys = spreadOrderKeysUnreserved(reordered.length, reservedKeys);
              yield* Effect.forEach(
                reordered,
                (page, index) =>
                  sql`
                    UPDATE watch_pages
                    SET order_key = ${keys[index]!}, updated_at = ${nowIso}
                    WHERE page_id = ${page.id}
                  `,
                { concurrency: 1, discard: true },
              );
            }
          }),
        );
        const page = yield* findPage(input.pageId);
        if (page === null) {
          return yield* watchError("Watch page not found.", { pageId: input.pageId });
        }
        yield* notifyChanged;
        return { page };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not reorder watch page.", { pageId: input.pageId, cause }),
        ),
      );

    const insertPageRow = (page: {
      readonly id: WatchPageId;
      readonly name: string;
      readonly scope: "global" | "project";
      readonly projectId: ProjectId | null;
      readonly orderKey: string;
      readonly nowIso: string;
    }) =>
      sql`
        INSERT INTO watch_pages ${sql.insert({
          page_id: page.id,
          name: page.name,
          scope: page.scope,
          project_id: page.projectId,
          order_key: page.orderKey,
          revision: 1,
          mobile_revision: 1,
          archived_at: null,
          created_at: page.nowIso,
          updated_at: page.nowIso,
        })}
      `;

    const insertWidgetRow = (widget: {
      readonly id: WatchWidgetId;
      readonly pageId: WatchPageId;
      readonly kind: string;
      readonly config: WatchWidgetConfig;
      readonly placement: WatchWidgetPlacement;
      readonly mobileOrder: number;
      readonly mobileHidden: boolean;
      readonly provenance: WatchWidgetProvenance;
      readonly nowIso: string;
    }) =>
      sql`
        INSERT INTO watch_widgets ${sql.insert({
          widget_id: widget.id,
          page_id: widget.pageId,
          kind: widget.kind,
          config_json: encodeWidgetConfigJson(widget.config),
          placement_x: widget.placement.x,
          placement_y: widget.placement.y,
          placement_w: widget.placement.w,
          placement_h: widget.placement.h,
          placement_min_cols: widget.placement.minCols ?? null,
          revision: 1,
          mobile_order: widget.mobileOrder,
          mobile_hidden: widget.mobileHidden ? 1 : 0,
          provenance: widget.provenance,
          created_at: widget.nowIso,
          updated_at: widget.nowIso,
        })}
      `;

    const duplicate: WatchPageService["Service"]["duplicate"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        const newId = yield* newPageId;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const source = yield* findPage(input.pageId);
            if (source === null) {
              return yield* watchError("Watch page not found.", { pageId: input.pageId });
            }
            if (source.archivedAt !== null) {
              return yield* watchError("Watch page is archived.", { pageId: input.pageId });
            }
            const nextRows = yield* sql<{ order_key: string }>`
              SELECT order_key FROM watch_pages
              WHERE archived_at IS NULL AND order_key > ${source.orderKey}
              ORDER BY order_key ASC, page_id ASC
              LIMIT 1
            `;
            // Archived rows between source and the next live page hold keys
            // the copy must not mint — reserved keys step past them.
            const reservedKeys = yield* archivedOrderKeys(source.orderKey);
            let orderKey = orderKeyBetweenUnreserved(
              source.orderKey,
              nextRows[0]?.order_key ?? null,
              reservedKeys,
            );
            if (orderKey === null) {
              orderKey = orderKeyAfter(source.orderKey);
              while (reservedKeys.has(orderKey)) orderKey = orderKeyAfter(orderKey);
            }
            yield* insertPageRow({
              id: newId,
              name: `${source.name} copy`,
              scope: source.scope,
              projectId: source.projectId,
              orderKey,
              nowIso,
            });
            const widgets = yield* widgetsForPage(input.pageId);
            yield* Effect.forEach(
              widgets,
              (widget) =>
                Effect.gen(function* () {
                  yield* insertWidgetRow({
                    id: yield* newWidgetId,
                    pageId: newId,
                    kind: widget.kind,
                    config: widget.config,
                    placement: widget.placement,
                    mobileOrder: widget.mobileOrder,
                    mobileHidden: widget.mobileHidden,
                    provenance: widget.provenance,
                    nowIso,
                  });
                }),
              { concurrency: 1, discard: true },
            );
          }),
        );
        const result = yield* pageWithWidgets(newId);
        yield* notifyChanged;
        return result;
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not duplicate watch page.", { pageId: input.pageId, cause }),
        ),
      );

    const deletePage: WatchPageService["Service"]["delete"] = (input) =>
      sql
        .withTransaction(
          sql`DELETE FROM watch_widgets WHERE page_id = ${input.pageId}`.pipe(
            Effect.andThen(
              sql<{ page_id: string }>`
                DELETE FROM watch_pages WHERE page_id = ${input.pageId} RETURNING page_id
              `,
            ),
            Effect.flatMap((rows) =>
              rows.length > 0
                ? Effect.void
                : watchError("Watch page not found.", { pageId: input.pageId }),
            ),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTypedWatchError(cause)
              ? cause
              : watchError("Could not delete watch page.", { pageId: input.pageId, cause }),
          ),
          Effect.andThen(notifyChanged),
          Effect.as({ id: input.pageId }),
        );

    const restore: WatchPageService["Service"]["restore"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        // Both revisions bump: a mobile projection writer holding the
        // pre-archive `mobileRevision` must invalidate the same way a stale
        // desktop `expectedRevision` does.
        const rows = yield* sql<{ page_id: string }>`
          UPDATE watch_pages
          SET archived_at = NULL,
              revision = revision + 1,
              mobile_revision = mobile_revision + 1,
              updated_at = ${nowIso}
          WHERE page_id = ${input.pageId} AND archived_at IS NOT NULL
          RETURNING page_id
        `;
        const page = yield* findPage(input.pageId);
        if (rows.length === 0) {
          if (page === null) {
            return yield* watchError("Watch page not found.", { pageId: input.pageId });
          }
          return yield* watchError("Watch page is not archived.", { pageId: input.pageId });
        }
        if (page === null) {
          return yield* watchError("Watch page not found.", { pageId: input.pageId });
        }
        yield* notifyChanged;
        return { page };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not restore watch page.", { pageId: input.pageId, cause }),
        ),
      );

    const updateScope: WatchPageService["Service"]["updateScope"] = (input) =>
      Effect.gen(function* () {
        const projectId = input.scope === "project" ? (input.projectId ?? null) : null;
        if (input.scope === "project" && projectId === null) {
          return yield* watchError("A project-scoped watch page requires a projectId.", {
            pageId: input.pageId,
          });
        }
        const nowIso = iso(yield* localNow);
        const rows = yield* sql<{ page_id: string }>`
          UPDATE watch_pages
          SET scope = ${input.scope},
              project_id = ${projectId},
              revision = revision + 1,
              updated_at = ${nowIso}
          WHERE page_id = ${input.pageId} AND archived_at IS NULL
          RETURNING page_id
        `;
        const page = yield* findPage(input.pageId);
        if (rows.length === 0) {
          if (page === null) {
            return yield* watchError("Watch page not found.", { pageId: input.pageId });
          }
          return yield* watchError("Watch page is archived.", { pageId: input.pageId });
        }
        if (page === null) {
          return yield* watchError("Watch page not found.", { pageId: input.pageId });
        }
        yield* notifyChanged;
        return { page };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not update watch page scope.", { pageId: input.pageId, cause }),
        ),
      );

    const instantiateFromGallery: WatchPageService["Service"]["instantiateFromGallery"] = (input) =>
      Effect.gen(function* () {
        const template = WATCH_GALLERY_TEMPLATES.find((entry) => entry.id === input.templateId);
        if (template === undefined) {
          return yield* watchError(`Watch gallery template not found: ${input.templateId}.`);
        }
        const projectId = input.projectId ?? null;
        const scope = projectId === null ? template.scope : "project";
        const nowIso = iso(yield* localNow);
        const newId = yield* newPageId;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Same read-in-transaction rule as `create`: `order_key` is not
            // UNIQUE, so the max-key read must see the latest committed row.
            const lastKey = yield* lastOrderKey;
            yield* insertPageRow({
              id: newId,
              name: template.name,
              scope,
              projectId,
              orderKey: lastKey === null ? "n" : orderKeyAfter(lastKey),
              nowIso,
            });
            yield* Effect.forEach(
              template.widgets,
              (templateWidget, index) =>
                Effect.gen(function* () {
                  yield* insertWidgetRow({
                    id: yield* newWidgetId,
                    pageId: newId,
                    kind: templateWidget.kind,
                    config: templateWidget.config,
                    placement: templateWidget.placement,
                    mobileOrder: index,
                    mobileHidden: false,
                    provenance: "firstParty",
                    nowIso,
                  });
                }),
              { concurrency: 1, discard: true },
            );
          }),
        );
        const result = yield* pageWithWidgets(newId);
        yield* notifyChanged;
        return result;
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not instantiate watch page from gallery.", { cause }),
        ),
      );

    const archiveForProject: WatchPageService["Service"]["archiveForProject"] = (projectId) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        const rows = yield* sql<{ page_id: string }>`
          UPDATE watch_pages
          SET archived_at = ${nowIso}, updated_at = ${nowIso}
          WHERE project_id = ${projectId} AND archived_at IS NULL
          RETURNING page_id
        `;
        if (rows.length > 0) yield* notifyChanged;
      }).pipe(
        Effect.mapError((cause) =>
          watchError("Could not archive watch pages for project.", { cause }),
        ),
      );

    const addWidget: WatchPageService["Service"]["addWidget"] = (input) =>
      Effect.gen(function* () {
        const id = yield* newWidgetId;
        const conflict = findLayoutConflict([{ id, placement: input.placement }]);
        if (conflict !== null) {
          return yield* new WatchLayoutCollisionError({
            pageId: input.pageId,
            widgetIds: [...conflict.widgetIds],
            message: conflict.message,
          });
        }
        const provenance = provenanceForAdd(input.kind, input.provenance);
        if (provenance === "invalid") {
          return yield* watchError(
            `Pack provenance is only valid on agent: widget kinds, not "${input.kind}".`,
            { pageId: input.pageId },
          );
        }
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (input.provenance !== undefined) {
              yield* assertPackProvenance(input.pageId, input.kind, input.provenance);
            }
            // Membership changes the mobile projection too, so both revisions move.
            yield* bumpPageRevision(input.pageId, input.expectedRevision, nowIso, {
              bumpMobile: true,
            });
            const widgets = yield* widgetsForPage(input.pageId);
            const collision = widgets.find((widget) =>
              placementsOverlap(widget.placement, input.placement),
            );
            if (collision !== undefined) {
              return yield* new WatchLayoutCollisionError({
                pageId: input.pageId,
                widgetIds: [collision.id],
                message: "Widget placement overlaps an existing widget.",
              });
            }
            const mobileOrder =
              widgets.length === 0 ? 0 : Math.max(...widgets.map((w) => w.mobileOrder)) + 1;
            yield* insertWidgetRow({
              id,
              pageId: input.pageId,
              kind: input.kind,
              config: input.config ?? {},
              placement: input.placement,
              mobileOrder,
              mobileHidden: false,
              provenance,
              nowIso,
            });
          }),
        );
        const widget = yield* findWidget(id);
        if (widget === null) {
          return yield* watchError("Watch widget not found after add.", { widgetId: id });
        }
        yield* notifyChanged;
        return { widget };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not add watch widget.", { pageId: input.pageId, cause }),
        ),
      );

    const removeWidget: WatchPageService["Service"]["removeWidget"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Membership changes the mobile projection too, so both revisions move.
            yield* bumpPageRevision(input.pageId, input.expectedRevision, nowIso, {
              bumpMobile: true,
            });
            const rows = yield* sql<{ widget_id: string }>`
              DELETE FROM watch_widgets
              WHERE widget_id = ${input.widgetId} AND page_id = ${input.pageId}
              RETURNING widget_id
            `;
            if (rows.length === 0) {
              return yield* watchError("Watch widget not found.", {
                pageId: input.pageId,
                widgetId: input.widgetId,
              });
            }
          }),
        );
        yield* notifyChanged;
        return { id: input.widgetId };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not remove watch widget.", {
                pageId: input.pageId,
                widgetId: input.widgetId,
                cause,
              }),
        ),
      );

    const configureWidget: WatchPageService["Service"]["configureWidget"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        // Archived pages are immutable: the EXISTS gate keeps a queued or
        // stale config write from landing on a parked page and resurrecting
        // with it on restore — the same guard every sibling write gets from
        // `bumpPageRevision`'s `archived_at IS NULL`.
        const rows = yield* sql<{ widget_id: string }>`
          UPDATE watch_widgets
          SET config_json = ${encodeWidgetConfigJson(input.config)},
              revision = revision + 1,
              updated_at = ${nowIso}
          WHERE widget_id = ${input.widgetId}
            AND revision = ${input.expectedRevision}
            AND EXISTS (
              SELECT 1 FROM watch_pages
              WHERE watch_pages.page_id = watch_widgets.page_id
                AND watch_pages.archived_at IS NULL
            )
          RETURNING widget_id
        `;
        if (rows.length === 0) {
          const widget = yield* findWidget(input.widgetId);
          if (widget === null) {
            return yield* watchError("Watch widget not found.", { widgetId: input.widgetId });
          }
          const page = yield* findPage(widget.pageId);
          if (page === null) {
            return yield* watchError("Watch page not found.", { pageId: widget.pageId });
          }
          if (page.archivedAt !== null) {
            return yield* watchError("Watch page is archived.", {
              pageId: widget.pageId,
              widgetId: input.widgetId,
            });
          }
          return yield* new WatchPageRevisionConflictError({
            pageId: widget.pageId,
            widgetId: input.widgetId,
            expectedRevision: input.expectedRevision,
            currentRevision: widget.revision,
            message: `Watch widget changed since revision ${input.expectedRevision}; reload and retry.`,
          });
        }
        const widget = yield* findWidget(input.widgetId);
        if (widget === null) {
          return yield* watchError("Watch widget not found.", { widgetId: input.widgetId });
        }
        yield* notifyChanged;
        return { widget };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not configure watch widget.", {
                widgetId: input.widgetId,
                cause,
              }),
        ),
      );

    const setLayout: WatchPageService["Service"]["setLayout"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* bumpPageRevision(input.pageId, input.expectedRevision, nowIso, {
              bumpMobile: false,
            });
            const widgets = yield* widgetsForPage(input.pageId);
            const overrides = new Map(
              input.layouts.map((layout) => [layout.widgetId, layout.placement]),
            );
            for (const widgetId of overrides.keys()) {
              if (!widgets.some((widget) => widget.id === widgetId)) {
                return yield* watchError("Watch widget not found on page.", {
                  pageId: input.pageId,
                  widgetId,
                });
              }
            }
            const placements = widgets.map((widget) => ({
              id: widget.id,
              placement: overrides.get(widget.id) ?? widget.placement,
            }));
            const conflict = findLayoutConflict(placements);
            if (conflict !== null) {
              return yield* new WatchLayoutCollisionError({
                pageId: input.pageId,
                widgetIds: [...conflict.widgetIds],
                message: conflict.message,
              });
            }
            yield* Effect.forEach(
              input.layouts,
              (layout) =>
                sql`
                  UPDATE watch_widgets
                  SET placement_x = ${layout.placement.x},
                      placement_y = ${layout.placement.y},
                      placement_w = ${layout.placement.w},
                      placement_h = ${layout.placement.h},
                      placement_min_cols = ${layout.placement.minCols ?? null},
                      updated_at = ${nowIso}
                  WHERE widget_id = ${layout.widgetId} AND page_id = ${input.pageId}
                `,
              { concurrency: 1, discard: true },
            );
          }),
        );
        const result = yield* pageWithWidgets(input.pageId);
        yield* notifyChanged;
        return result;
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not set watch page layout.", { pageId: input.pageId, cause }),
        ),
      );

    const setMobileProjection: WatchPageService["Service"]["setMobileProjection"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // The mobile projection shares no fields or revision with desktop
            // layout — this bump touches mobile_revision alone.
            yield* bumpMobileRevision(input.pageId, input.expectedMobileRevision, nowIso);
            yield* Effect.forEach(
              input.widgets,
              (patch) =>
                sql<{ widget_id: string }>`
                  UPDATE watch_widgets
                  SET mobile_order = ${patch.mobileOrder},
                      mobile_hidden = ${patch.mobileHidden ? 1 : 0},
                      updated_at = ${nowIso}
                  WHERE widget_id = ${patch.widgetId} AND page_id = ${input.pageId}
                  RETURNING widget_id
                `.pipe(
                  Effect.flatMap((rows) =>
                    rows.length > 0
                      ? Effect.void
                      : watchError("Watch widget not found on page.", {
                          pageId: input.pageId,
                          widgetId: patch.widgetId,
                        }),
                  ),
                ),
              { concurrency: 1, discard: true },
            );
          }),
        );
        const result = yield* pageWithWidgets(input.pageId);
        yield* notifyChanged;
        return result;
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not set watch page mobile projection.", {
                pageId: input.pageId,
                cause,
              }),
        ),
      );

    const moveToPage: WatchPageService["Service"]["moveToPage"] = (input) =>
      Effect.gen(function* () {
        // A move onto the same page is a no-op: the two revision bumps below
        // would both hit the one row, so the second would miss on the
        // just-bumped revision and report a phantom conflict.
        if (input.sourcePageId === input.destinationPageId) {
          const widget = yield* findWidget(input.widgetId);
          if (widget === null || widget.pageId !== input.sourcePageId) {
            return yield* watchError("Watch widget not found on source page.", {
              pageId: input.sourcePageId,
              widgetId: input.widgetId,
            });
          }
          return { widget };
        }
        const conflict = findLayoutConflict([{ id: input.widgetId, placement: input.placement }]);
        if (conflict !== null) {
          return yield* new WatchLayoutCollisionError({
            pageId: input.destinationPageId,
            widgetIds: [input.widgetId],
            message: conflict.message,
          });
        }
        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // The move writes membership on both pages; a stale revision on
            // either rejects the whole move inside one transaction.
            yield* bumpPageRevision(input.sourcePageId, input.sourceExpectedRevision, nowIso, {
              bumpMobile: true,
            });
            yield* bumpPageRevision(
              input.destinationPageId,
              input.destinationExpectedRevision,
              nowIso,
              { bumpMobile: true },
            );
            const widget = yield* findWidget(input.widgetId);
            if (widget === null || widget.pageId !== input.sourcePageId) {
              return yield* watchError("Watch widget not found on source page.", {
                pageId: input.sourcePageId,
                widgetId: input.widgetId,
              });
            }
            const destinationWidgets = yield* widgetsForPage(input.destinationPageId);
            const collision = destinationWidgets.find((destination) =>
              placementsOverlap(destination.placement, input.placement),
            );
            if (collision !== undefined) {
              return yield* new WatchLayoutCollisionError({
                pageId: input.destinationPageId,
                widgetIds: [input.widgetId, collision.id],
                message: "Widget placement overlaps an existing widget.",
              });
            }
            const mobileOrder =
              destinationWidgets.length === 0
                ? 0
                : Math.max(...destinationWidgets.map((w) => w.mobileOrder)) + 1;
            yield* sql`
              UPDATE watch_widgets
              SET page_id = ${input.destinationPageId},
                  placement_x = ${input.placement.x},
                  placement_y = ${input.placement.y},
                  placement_w = ${input.placement.w},
                  placement_h = ${input.placement.h},
                  placement_min_cols = ${input.placement.minCols ?? null},
                  mobile_order = ${mobileOrder},
                  mobile_hidden = 0,
                  updated_at = ${nowIso}
              WHERE widget_id = ${input.widgetId}
            `;
          }),
        );
        const widget = yield* findWidget(input.widgetId);
        if (widget === null) {
          return yield* watchError("Watch widget not found after move.", {
            widgetId: input.widgetId,
          });
        }
        yield* notifyChanged;
        return { widget };
      }).pipe(
        Effect.mapError((cause) =>
          isTypedWatchError(cause)
            ? cause
            : watchError("Could not move watch widget.", {
                widgetId: input.widgetId,
                cause,
              }),
        ),
      );

    return WatchPageService.of({
      list,
      subscribeList,
      listGallery,
      create,
      rename,
      reorder,
      duplicate,
      delete: deletePage,
      restore,
      updateScope,
      instantiateFromGallery,
      archiveForProject,
      addWidget,
      removeWidget,
      configureWidget,
      setLayout,
      setMobileProjection,
      moveToPage,
    });
  }),
);

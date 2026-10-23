import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  isUnknownUnionMember,
  WatchConnectorError,
  type WatchConnectorErrorReason,
  type WatchNotificationEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { UserNotificationService } from "../../notifications/UserNotificationService.ts";
import * as WidgetTranspileService from "../WidgetTranspileService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ConfirmationTokens from "./ConfirmationTokens.ts";
import * as ConnectorService from "./ConnectorService.ts";
import * as PackStore from "./PackStore.ts";

// Layers merged this way see every service provided later in the chain —
// siblings inside one Layer.mergeAll would not.
const layerInfra = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerSecretStore.layer,
  ConfirmationTokens.layer,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "watch-connector-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * History-recording stub: `emit` appends, `history` reads back newest-first
 * — the same contract the real service exposes, without the event tap.
 */
const layerNotifications = Layer.effect(
  UserNotificationService,
  Effect.gen(function* () {
    const emitted = yield* Ref.make<ReadonlyArray<WatchNotificationEvent>>([]);
    return {
      subscribe: () => Stream.empty,
      history: () =>
        Ref.get(emitted).pipe(
          Effect.map((events) => ({
            entries: events.map((notification) => ({
              notification,
              recordedAt: isUnknownUnionMember(notification) ? "" : notification.createdAt,
            })),
          })),
        ),
      getPrefs: () => Effect.die(new Error("getPrefs is not used by these tests")),
      setPrefs: () => Effect.die(new Error("setPrefs is not used by these tests")),
      emit: (notification) =>
        Ref.update(emitted, (events) => [notification, ...events]).pipe(
          Effect.as({ recorded: true }),
        ),
      awaitStarted: () => Effect.void,
      awaitProcessed: () => Effect.void,
    } satisfies UserNotificationService["Service"];
  }),
);

/** Echo transpiler — pack widget registration needs the publish path, not a real build. */
const layerWidgetTranspile = WidgetTranspileService.makeLayer().pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(WidgetTranspileService.WidgetSourceTranspiler, {
        transpile: (source) => Effect.succeed(source),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "watch-widget-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

const layerConnectorDeps = Layer.mergeAll(
  layerInfra,
  PackStore.layerPackFetch,
  layerNotifications,
  layerWidgetTranspile,
);
const layerTest = ConnectorService.layer.pipe(Layer.provideMerge(layerConnectorDeps));
const layerTestWithFetch = (fetchLayer: Layer.Layer<PackStore.ConnectorPackFetch>) =>
  ConnectorService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerInfra, fetchLayer, layerNotifications, layerWidgetTranspile),
    ),
  );

const stubFetch = (handlers: {
  readonly resolve?: (
    host: string,
  ) => Effect.Effect<ReadonlyArray<PackStore.PackFetchAddress>, WatchConnectorError>;
  readonly get?: (
    url: string,
    addresses: ReadonlyArray<PackStore.PackFetchAddress>,
  ) => Effect.Effect<PackStore.PackFetchResponse, WatchConnectorError>;
}) =>
  Layer.succeed(PackStore.ConnectorPackFetch, {
    resolve: handlers.resolve ?? (() => Effect.succeed([{ address: "93.184.216.34", family: 4 }])),
    get: handlers.get ?? (() => Effect.die(new Error("pack fetch should not have been called"))),
  });

const okResponse = (body: string): PackStore.PackFetchResponse => ({
  status: 200,
  location: null,
  body: new TextEncoder().encode(body),
});

const wireBundle = (body: unknown = manifestBody(), files: Record<string, string> = {}) =>
  JSON.stringify({
    manifest: body,
    files: { "connector.js": ECHO_CONNECTOR, ...files },
  });

const manifestBody = (overrides?: Record<string, unknown>) => ({
  id: "pack.test",
  schemaVersion: 1,
  operations: [],
  egressHosts: ["packs.example.com"],
  secretKeys: ["apiKey"],
  transport: "http",
  authSchema: {
    required: ["repo"],
    properties: { repo: { type: "string" } },
    additionalProperties: false,
  },
  ...overrides,
});

/** Minimal valid entry: the upgrade re-pin path evaluates connector.js even without a migrator. */
const ECHO_CONNECTOR = `module.exports = { transform: (raw) => raw };`;

const writePackDir = (body: unknown, files: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "watch-pack-" });
    yield* fs.writeFileString(path.join(dir, "manifest.json"), JSON.stringify(body));
    yield* fs.writeFileString(path.join(dir, "connector.js"), ECHO_CONNECTOR);
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
    return dir;
  });

const isConnectorError = Schema.is(WatchConnectorError);

const expectFailure = <A, R>(
  reason: WatchConnectorErrorReason,
  effect: Effect.Effect<A, WatchConnectorError, R>,
) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        assert.isTrue(isConnectorError(error), "expected a WatchConnectorError");
        if (isConnectorError(error)) assert.equal(error.reason, reason);
        return Effect.void;
      },
      onSuccess: () => Effect.die(new Error("expected the effect to fail")),
    }),
  );

const installPack = Effect.gen(function* () {
  const svc = yield* ConnectorService.ConnectorService;
  const dir = yield* writePackDir(manifestBody());
  const { request } = yield* svc.requestInstall({
    origin: { kind: "localPath", path: dir },
  });
  const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
  const { pack } = yield* svc.confirmInstall({
    requestId: request.id,
    confirmationToken: prepared.confirmationToken,
  });
  return { pack, dir };
});

it.effect("runs the full request → prepare → confirm install lifecycle", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const dir = yield* writePackDir(manifestBody());

    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    assert.equal(request.kind, "install");
    assert.equal(request.status, "pending");
    assert.equal(request.packId, "pack.test");
    assert.match(request.contentHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(request.manifest?.id, "pack.test");
    assert.deepEqual(request.manifest?.secretKeys, ["apiKey"]);

    // A wrong token is refused and the request stays pending.
    yield* expectFailure(
      "confirmationInvalid",
      svc.confirmInstall({ requestId: request.id, confirmationToken: "watch-confirm:bogus" }),
    );

    const { request: prepared, confirmationToken } = yield* svc.prepareInstallConfirm({
      requestId: request.id,
    });
    assert.equal(prepared.status, "pending");
    assert.isString(confirmationToken);

    const { pack } = yield* svc.confirmInstall({
      requestId: request.id,
      confirmationToken,
    });
    assert.equal(pack.packId, "pack.test");
    assert.equal(pack.schemaVersion, 1);
    assert.isString(pack.approvedAt);
    assert.isNull(pack.archivedAt);

    const listed = yield* svc.list({});
    assert.equal(listed.packs.length, 1);
    // Only pending requests surface to clients; this one resolved.
    assert.equal(listed.installRequests.length, 0);

    // Reconfirming a resolved request refuses — even with a (consumed) token.
    yield* expectFailure(
      "requestNotPending",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a confirm when the pack content changed since the request", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* writePackDir(manifestBody());
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });

    // The origin refetches different bytes than the human approved.
    yield* fs.writeFileString(path.join(dir, "fetch.ts"), "export default 2");
    yield* expectFailure(
      "hashMismatch",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );
    assert.equal((yield* svc.list({})).packs.length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a confirm when the declared manifest row was mutated", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const sql = yield* SqlClient.SqlClient;
    const dir = yield* writePackDir(manifestBody());
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });

    // A rewritten declared manifest no longer hashes to the recorded pin.
    yield* sql`UPDATE watch_connector_install_requests SET manifest_json = ${JSON.stringify(
      manifestBody({ egressHosts: ["evil.example.com"] }),
    )} WHERE request_id = ${request.id}`;
    yield* expectFailure(
      "hashMismatch",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels a pending request and refuses confirm afterwards", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const dir = yield* writePackDir(manifestBody());
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { request: cancelled } = yield* svc.cancelInstallRequest({ requestId: request.id });
    assert.equal(cancelled.status, "cancelled");
    yield* expectFailure("requestNotPending", svc.prepareInstallConfirm({ requestId: request.id }));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("runs the upgrade request lifecycle and re-pins the named instance", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });
    assert.equal(instance.schemaVersion, 1);

    const dirV2 = yield* writePackDir(manifestBody({ schemaVersion: 2 }));
    const { request } = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
      instanceId: instance.id,
    });
    assert.equal(request.kind, "upgrade");
    assert.equal(request.upgrade?.fromSchemaVersion, 1);
    assert.equal(request.upgrade?.instanceId, instance.id);

    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    const { pack: upgraded } = yield* svc.confirmUpgrade({
      requestId: request.id,
      confirmationToken,
    });
    assert.equal(upgraded.schemaVersion, 2);

    const { instances, packs } = yield* svc.list({});
    // Both approved versions stay on record — the manifest history.
    assert.deepEqual(packs.map((row) => row.schemaVersion).toSorted(), [1, 2]);
    assert.equal(instances[0]?.schemaVersion, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a downgrade upgrade request", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;
    const sameVersion = yield* writePackDir(manifestBody({ schemaVersion: 1 }));
    yield* expectFailure(
      "downgradeRejected",
      svc.requestUpgrade({
        packId: pack.packId,
        origin: { kind: "localPath", path: sameVersion },
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("validates config against the manifest auth schema and stores secrets by key", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const sql = yield* SqlClient.SqlClient;
    const { pack } = yield* installPack;

    // Missing a required auth field.
    yield* expectFailure("configInvalid", svc.createInstance({ packId: pack.packId, config: {} }));
    // A secret key the manifest never declared.
    yield* expectFailure(
      "secretKeyUndeclared",
      svc.createInstance({
        packId: pack.packId,
        config: { repo: "t3" },
        secrets: { notDeclared: "x" },
      }),
    );
    // A config field the schema closes over.
    yield* expectFailure(
      "configInvalid",
      svc.createInstance({
        packId: pack.packId,
        config: { repo: "t3", other: "x" },
      }),
    );

    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      name: "ci",
      config: { repo: "t3" },
      secrets: { apiKey: "s3cr3t" },
    });
    assert.equal(instance.name, "ci");
    assert.deepEqual(instance.configuredSecretKeys, ["apiKey"]);
    // The value is never on the instance payload or its row — only the key is.
    assert.isUndefined(instance.config["apiKey"]);
    const rows = yield* sql<{ config_json: string; secret_keys_json: string }>`
      SELECT config_json, secret_keys_json FROM watch_connector_instances
      WHERE instance_id = ${instance.id}
    `;
    assert.notInclude(rows[0]?.config_json, "s3cr3t");
    assert.notInclude(rows[0]?.secret_keys_json, "s3cr3t");

    const stored = yield* secrets.get(`watch-connector.${instance.id.replaceAll(":", "_")}.apiKey`);
    assert.isTrue(stored._tag === "Some");
    if (stored._tag === "Some") {
      assert.equal(new TextDecoder().decode(stored.value), "s3cr3t");
    }

    // setInstanceConfig updates config, writes new secrets, clears by key.
    const { instance: updated } = yield* svc.setInstanceConfig({
      instanceId: instance.id,
      config: { repo: "t3-renamed" },
      secrets: { apiKey: "rotated" },
    });
    assert.equal(updated.config["repo"], "t3-renamed");
    const rotated = yield* secrets.get(
      `watch-connector.${instance.id.replaceAll(":", "_")}.apiKey`,
    );
    assert.isTrue(rotated._tag === "Some");
    if (rotated._tag === "Some") {
      assert.equal(new TextDecoder().decode(rotated.value), "rotated");
    }

    yield* expectFailure(
      "secretKeyUndeclared",
      svc.setInstanceConfig({
        instanceId: instance.id,
        config: { repo: "t3" },
        clearSecretKeys: ["notDeclared"],
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects config entries keyed by a declared secret name at create and update", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    // No authSchema: the rejection must come from the secret-key check, not
    // schema validation. `field` names the offending key.
    const dir = yield* writePackDir(manifestBody({ authSchema: undefined }));
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
    const { pack } = yield* svc.confirmInstall({
      requestId: request.id,
      confirmationToken: prepared.confirmationToken,
    });

    const createResult = yield* svc
      .createInstance({
        packId: pack.packId,
        config: { repo: "t3", apiKey: "plaintext" },
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(createResult));
    if (Result.isFailure(createResult)) {
      assert.equal(createResult.failure.reason, "configInvalid");
      assert.equal(createResult.failure.field, "apiKey");
    }

    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
      secrets: { apiKey: "s3cr3t" },
    });
    const updateResult = yield* svc
      .setInstanceConfig({
        instanceId: instance.id,
        config: { repo: "t3", apiKey: "plaintext" },
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(updateResult));
    if (Result.isFailure(updateResult)) {
      assert.equal(updateResult.failure.reason, "configInvalid");
      assert.equal(updateResult.failure.field, "apiKey");
    }
    // The refused writes left nothing behind.
    assert.deepEqual((yield* svc.list({})).instances[0]?.config, { repo: "t3" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("emits the connector list on subscribe and after each change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const firstSeen = yield* Deferred.make<void>();
      const taken = yield* svc.subscribeList({}).pipe(
        Stream.tap(() => Deferred.succeed(firstSeen, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstSeen);
      const dir = yield* writePackDir(manifestBody());
      yield* svc.requestInstall({ origin: { kind: "localPath", path: dir } });
      const emissions = yield* Fiber.join(taken);
      assert.equal(emissions.length, 2);
      assert.equal(emissions[0]?.installRequests.length, 0);
      assert.equal(emissions[1]?.installRequests.length, 1);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "records a private-URL request without fetching and gates the fetch on the human ack",
  () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const layer = layerTestWithFetch(
        stubFetch({
          resolve: () => Effect.succeed([{ address: "10.0.0.7", family: 4 }]),
          get: () =>
            Effect.sync(() => {
              fetchCount += 1;
              return okResponse(wireBundle());
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        // Even with allowLocalUrl set on the request payload — a flag an
        // agent controls — the request leg never fetches a private URL.
        const { request } = yield* svc.requestInstall({
          origin: {
            kind: "httpsUrl",
            url: "https://internal.example.net/pack.json",
            allowLocalUrl: true,
          },
        });
        assert.isTrue(request.localUrl);
        assert.isNull(request.manifest);
        assert.isNull(request.contentHash);
        assert.isNull(request.packId);
        assert.equal(fetchCount, 0);

        // Prepare without the acknowledgement refuses — still no fetch.
        yield* expectFailure("urlBlocked", svc.prepareInstallConfirm({ requestId: request.id }));
        assert.equal(fetchCount, 0);

        // The acked prepare performs the deferred fetch and fills the row.
        const prepared = yield* svc.prepareInstallConfirm({
          requestId: request.id,
          allowLocalUrl: true,
        });
        assert.equal(fetchCount, 1);
        assert.equal(prepared.request.packId, "pack.test");
        assert.equal(prepared.request.manifest?.id, "pack.test");
        assert.isTrue(prepared.request.localUrl);

        const { pack } = yield* svc.confirmInstall({
          requestId: request.id,
          confirmationToken: prepared.confirmationToken,
        });
        assert.equal(pack.packId, "pack.test");
        // The confirm leg refetches the now human-acked URL.
        assert.equal(fetchCount, 2);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("refuses to confirm an upgrade that would re-pin an older approved version", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;

    const dirV2 = yield* writePackDir(manifestBody({ schemaVersion: 2 }));
    const dirV3 = yield* writePackDir(manifestBody({ schemaVersion: 3 }));
    const stale = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
    });
    const fresh = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV3 },
    });
    // v3 confirms first, making the v2 request stale.
    const freshPrep = yield* svc.prepareInstallConfirm({ requestId: fresh.request.id });
    yield* svc.confirmUpgrade({
      requestId: fresh.request.id,
      confirmationToken: freshPrep.confirmationToken,
    });
    const stalePrep = yield* svc.prepareInstallConfirm({ requestId: stale.request.id });
    yield* expectFailure(
      "downgradeRejected",
      svc.confirmUpgrade({
        requestId: stale.request.id,
        confirmationToken: stalePrep.confirmationToken,
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

// ── Phase 3c: versioning, rollback, uninstall, purge, pack widgets ───────

const migrateConnector = (body: string) => `module.exports = {
  transform: (raw) => raw,
  migrateConfig: ${body},
};`;

const upgradeToV2 = (
  files: Record<string, string> = {},
  manifestOverrides: Record<string, unknown> = { schemaVersion: 2 },
) =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });
    const dirV2 = yield* writePackDir(manifestBody(manifestOverrides), files);
    const { request } = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
      instanceId: instance.id,
    });
    return { svc, pack, instance, request };
  });

it.effect("an upgrade cannot complete without the human confirmation token", () =>
  Effect.gen(function* () {
    const { svc, instance, request } = yield* upgradeToV2();
    // No token, a bogus token — both refuse; the instance stays pinned to v1.
    yield* expectFailure(
      "confirmationInvalid",
      svc.confirmUpgrade({ requestId: request.id, confirmationToken: "watch-confirm:bogus" }),
    );
    const { instances } = yield* svc.list({});
    const current = instances.find((row) => row.id === instance.id);
    assert.equal(current?.schemaVersion, 1);
    assert.equal((yield* svc.list({})).packs.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("runs pack-provided migrateConfig server-side on a confirmed upgrade", () =>
  Effect.gen(function* () {
    const { svc, instance, request } = yield* upgradeToV2(
      {
        "connector.js": migrateConnector(
          `(from, to, ctx) => ({ repo: ctx.config.repo, region: "iad" })`,
        ),
      },
      {
        schemaVersion: 2,
        authSchema: {
          required: ["repo", "region"],
          properties: { repo: { type: "string" }, region: { type: "string" } },
          additionalProperties: false,
        },
      },
    );
    const { confirmationToken, diffBase } = yield* svc.prepareInstallConfirm({
      requestId: request.id,
    });
    assert.equal(diffBase?.schemaVersion, 1);
    const { pack } = yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });
    assert.equal(pack.schemaVersion, 2);

    const { instances } = yield* svc.list({});
    const pinned = instances.find((row) => row.id === instance.id);
    assert.equal(pinned?.schemaVersion, 2);
    assert.deepEqual(pinned?.config, { repo: "t3", region: "iad" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a failing migrateConfig keeps the instance config and flags it unhealthy", () =>
  Effect.gen(function* () {
    const { svc, instance, request } = yield* upgradeToV2(
      {
        "connector.js": migrateConnector(`() => { throw new Error("nope") }`),
      },
      { schemaVersion: 2 },
    );
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });

    const { instances } = yield* svc.list({});
    const pinned = instances.find((row) => row.id === instance.id);
    assert.equal(pinned?.schemaVersion, 2);
    // The previous, valid config survived the failed migration untouched.
    assert.deepEqual(pinned?.config, { repo: "t3" });
    assert.equal(pinned?.health.status, "unhealthy");
    assert.match(pinned?.health.lastError ?? "", /migrateConfig\(1 → 2\) failed/);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("migrateConfig cannot launder secret material into config_json on re-pin", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const sql = yield* SqlClient.SqlClient;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
      secrets: { apiKey: "s3cr3t" },
    });
    // The migration gets no `ctx.secrets` — the scrub is the second line:
    // a declared-key entry and an entry equal to a resolved secret value are
    // both stripped before the migrated config persists.
    const dirV2 = yield* writePackDir(manifestBody({ schemaVersion: 2, authSchema: undefined }), {
      "connector.js": migrateConnector(
        `(from, to, ctx) => ({ repo: ctx.config.repo, apiKey: "s3cr3t", note: "s3cr3t" })`,
      ),
    });
    const { request } = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
      instanceId: instance.id,
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });

    const { instances } = yield* svc.list({});
    const pinned = instances.find((row) => row.id === instance.id);
    assert.equal(pinned?.schemaVersion, 2);
    assert.deepEqual(pinned?.config, { repo: "t3" });
    const rows = yield* sql<{ config_json: string }>`
      SELECT config_json FROM watch_connector_instances
      WHERE instance_id = ${instance.id}
    `;
    assert.notInclude(rows[0]?.config_json ?? "", "s3cr3t");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a re-pin prunes configured keys and stored values the manifest dropped", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const dir = yield* writePackDir(manifestBody({ secretKeys: ["apiKey", "legacyKey"] }));
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
    const { pack } = yield* svc.confirmInstall({
      requestId: request.id,
      confirmationToken: prepared.confirmationToken,
    });
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
      secrets: { apiKey: "a", legacyKey: "l" },
    });
    assert.deepEqual(instance.configuredSecretKeys, ["apiKey", "legacyKey"]);
    const storeName = (key: string) => `watch-connector.${instance.id.replaceAll(":", "_")}.${key}`;

    const dirV2 = yield* writePackDir(manifestBody({ schemaVersion: 2, secretKeys: ["apiKey"] }));
    const upgrade = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
      instanceId: instance.id,
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({
      requestId: upgrade.request.id,
    });
    yield* svc.confirmUpgrade({ requestId: upgrade.request.id, confirmationToken });

    const { instances } = yield* svc.list({});
    const pinned = instances.find((row) => row.id === instance.id);
    assert.equal(pinned?.schemaVersion, 2);
    // The row stops advertising the dropped key and the value is gone.
    assert.deepEqual(pinned?.configuredSecretKeys, ["apiKey"]);
    assert.isTrue(Option.isNone(yield* secrets.get(storeName("legacyKey"))));
    assert.isTrue(Option.isSome(yield* secrets.get(storeName("apiKey"))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("clearSecretKeys still revokes configured keys the manifest dropped", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const sql = yield* SqlClient.SqlClient;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
      secrets: { apiKey: "s3cr3t" },
    });
    // Simulate a pre-fix row: `legacyKey` was configured under an older
    // manifest that declared it, and the re-pin predates pruning. The clear
    // must still reach it — the configured set is revocable even when the
    // pinned manifest no longer names the key.
    yield* sql`
      UPDATE watch_connector_instances
      SET secret_keys_json = '["apiKey","legacyKey"]'
      WHERE instance_id = ${instance.id}
    `;
    const { instance: updated } = yield* svc.setInstanceConfig({
      instanceId: instance.id,
      config: { repo: "t3" },
      clearSecretKeys: ["legacyKey"],
    });
    assert.deepEqual(updated.configuredSecretKeys, ["apiKey"]);
    // A key neither declared nor configured is still refused.
    yield* expectFailure(
      "secretKeyUndeclared",
      svc.setInstanceConfig({
        instanceId: instance.id,
        config: { repo: "t3" },
        clearSecretKeys: ["neverSeen"],
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back to a previously-approved version without fetching", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const notifications = yield* UserNotificationService;
    const fs = yield* FileSystem.FileSystem;
    const { pack, dir: v1Origin } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });
    const dirV2 = yield* writePackDir(manifestBody({ schemaVersion: 2 }));
    const { request } = yield* svc.requestUpgrade({
      packId: pack.packId,
      origin: { kind: "localPath", path: dirV2 },
      instanceId: instance.id,
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });

    // Rollback to the never-approved version refuses.
    yield* expectFailure(
      "versionNotApproved",
      svc.rollback({ instanceId: instance.id, schemaVersion: 9 }),
    );

    // Deleting the v1 origin dir would break any refetch — the re-pin must
    // read only the materialized, hash-pinned copy on disk.
    yield* fs.remove(v1Origin, { recursive: true });

    const { instance: rolled } = yield* svc.rollback({
      instanceId: instance.id,
      schemaVersion: 1,
    });
    assert.equal(rolled.schemaVersion, 1);
    assert.equal(rolled.health.lastRollback?.fromSchemaVersion, 2);
    assert.equal(rolled.health.lastRollback?.toSchemaVersion, 1);

    const history = yield* notifications.history({});
    const rolledBack = history.entries.find(
      (entry) =>
        !isUnknownUnionMember(entry.notification) &&
        entry.notification.type === "connector.rolledBack",
    );
    assert.isDefined(rolledBack);
    const notification = rolledBack?.notification;
    if (notification !== undefined && !isUnknownUnionMember(notification)) {
      assert.equal(notification.type, "connector.rolledBack");
      if (notification.type === "connector.rolledBack") {
        assert.equal(notification.instanceId, instance.id);
        assert.equal(notification.packId, pack.packId);
        assert.equal(notification.fromSchemaVersion, 2);
        assert.equal(notification.toSchemaVersion, 1);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a rollback to the version the instance already pins", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const notifications = yield* UserNotificationService;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });

    yield* expectFailure(
      "sameVersionRollback",
      svc.rollback({ instanceId: instance.id, schemaVersion: 1 }),
    );

    // No re-pin happened and no misleading from == to event was recorded.
    const { instances } = yield* svc.list({});
    assert.equal(instances[0]?.schemaVersion, 1);
    const history = yield* notifications.history({});
    assert.isFalse(
      history.entries.some(
        (entry) =>
          !isUnknownUnionMember(entry.notification) &&
          entry.notification.type === "connector.rolledBack",
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("soft-archive uninstall hides the pack and retains instance config", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });

    const result = yield* svc.uninstall({ packId: pack.packId });
    assert.equal(result.archivedInstances, 1);

    // Default listing hides the archived pack and instance entirely.
    const listed = yield* svc.list({});
    assert.equal(listed.packs.length, 0);
    assert.equal(listed.instances.length, 0);

    // Archived view keeps both — config intact.
    const archived = yield* svc.list({ includeArchived: true });
    assert.equal(archived.packs.length, 1);
    assert.equal(archived.packs[0]?.archivedAt !== null, true);
    const kept = archived.instances.find((row) => row.id === instance.id);
    assert.isNotNull(kept?.archivedAt ?? null);
    assert.deepEqual(kept?.config, { repo: "t3" });

    // The runtime refuses archived instances — the poller turns this into
    // the connectorMissing placeholder.
    yield* expectFailure("instanceNotFound", svc.loadRuntime(instance.id));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reinstalling an archived version revives its archived instances", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack, dir } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
    });
    yield* svc.uninstall({ packId: pack.packId });

    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmInstall({ requestId: request.id, confirmationToken });

    const listed = yield* svc.list({});
    const revived = listed.instances.find((row) => row.id === instance.id);
    assert.isNull(revived?.archivedAt ?? null);
    assert.deepEqual(revived?.config, { repo: "t3" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("purge is token-gated and destroys only the archived pack's data", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const { pack } = yield* installPack;
    const { instance } = yield* svc.createInstance({
      packId: pack.packId,
      config: { repo: "t3" },
      secrets: { apiKey: "s3cr3t" },
    });

    // Not archived yet — prepare refuses.
    yield* expectFailure("packNotArchived", svc.preparePurge({ packId: pack.packId }));
    yield* svc.uninstall({ packId: pack.packId });

    const prepared = yield* svc.preparePurge({ packId: pack.packId });
    assert.deepEqual(prepared.instances, [instance.id]);
    assert.deepEqual(prepared.schemaVersions, [1]);

    // A bogus token refuses; the data all survives.
    yield* expectFailure(
      "confirmationInvalid",
      svc.purgeInstanceData({ packId: pack.packId, confirmationToken: "watch-confirm:bogus" }),
    );
    const stillThere = yield* svc.list({ includeArchived: true });
    assert.equal(stillThere.instances.length, 1);

    const result = yield* svc.purgeInstanceData({
      packId: pack.packId,
      confirmationToken: prepared.confirmationToken,
    });
    assert.equal(result.purgedInstances, 1);

    const purged = yield* svc.list({ includeArchived: true });
    assert.equal(purged.packs.length, 0);
    assert.equal(purged.instances.length, 0);

    // The stored secret value is gone too.
    const secret = yield* secrets.get(`watch-connector.${instance.id.replaceAll(":", "_")}.apiKey`);
    assert.isTrue(secret._tag === "None");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("purge destroys the pack's derived widget sources and their artifacts", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const transpile = yield* WidgetTranspileService.WidgetTranspileService;
    const widgetSource = "export default function Status() { return null }";
    const dir = yield* writePackDir(
      manifestBody({
        widgets: [
          {
            name: "pack-status",
            file: "widgets/status.tsx",
            bridge: { subscriptions: [], actions: [] },
          },
        ],
      }),
      { "widgets/status.tsx": widgetSource },
    );
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    const { pack } = yield* svc.confirmInstall({ requestId: request.id, confirmationToken });

    const { widgetSources } = yield* svc.list({});
    const sourceId = widgetSources[0]!.sourceId;
    assert.equal((yield* transpile.get({ sourceId })).source?.status, "ready");

    yield* svc.uninstall({ packId: pack.packId });
    const prepared = yield* svc.preparePurge({ packId: pack.packId });
    assert.deepEqual(prepared.widgetSources, [sourceId]);
    yield* svc.purgeInstanceData({
      packId: pack.packId,
      confirmationToken: prepared.confirmationToken,
    });

    // The derived record is gone — nothing fetchable survives the purge.
    const { source, bundle } = yield* transpile.get({ sourceId });
    assert.isNull(source);
    assert.isNull(bundle);
    const tombstone = yield* transpile
      .subscribe({ sourceId })
      .pipe(Stream.take(1), Stream.runCollect);
    assert.deepEqual([...tombstone], [null]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pack-shipped TSX widgets register through the transpile pipeline on confirm", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const widgetSource = "export default function Status() { return null }";
    const dir = yield* writePackDir(
      manifestBody({
        widgets: [
          {
            name: "pack-status",
            file: "widgets/status.tsx",
            bridge: { subscriptions: ["connector"], actions: [] },
          },
        ],
      }),
      { "widgets/status.tsx": widgetSource },
    );
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmInstall({ requestId: request.id, confirmationToken });

    const { widgetSources } = yield* svc.list({});
    assert.equal(widgetSources.length, 1);
    const registered = widgetSources[0]!;
    assert.equal(registered.packId, "pack.test");
    assert.equal(registered.name, "pack-status");
    assert.equal(registered.file, "widgets/status.tsx");
    // The sourceId is the content-hashed `agent:` kind widgets mount under;
    // the pack provenance (`pack:<packId>`) is recorded when the widget is added.
    assert.match(registered.sourceId, /^watch-widget-source:[0-9a-f]{64}$/);
    assert.isNull(registered.archivedAt);

    // The artifact is a real publish — the transpile service serves it.
    const transpile = yield* WidgetTranspileService.WidgetTranspileService;
    const fetched = yield* transpile.get({ sourceId: registered.sourceId });
    assert.equal(fetched.source?.status, "ready");

    // Archiving the pack archives its widget registrations in the listing.
    yield* svc.uninstall({ packId: registered.packId });
    assert.equal((yield* svc.list({})).widgetSources.length, 0);
    const archived = yield* svc.list({ includeArchived: true });
    assert.isNotNull(archived.widgetSources[0]?.archivedAt ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a manifest whose declared widget file is not in the bundle", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const dir = yield* writePackDir(
      manifestBody({
        widgets: [
          {
            name: "ghost",
            file: "widgets/missing.tsx",
            bridge: { subscriptions: [], actions: [] },
          },
        ],
      }),
    );
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* expectFailure(
      "manifestInvalid",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );
  }).pipe(Effect.provide(layerTest)),
);

// ── Confirm-path integrity ───────────────────────────────────────────────

it.effect("rejects different content under an already-approved (pack, version) pin", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;

    // Same schemaVersion, different manifest (egress policy changed): the
    // upsert must refuse rather than retcon the approved pin. New bytes
    // need a new schemaVersion.
    const dir = yield* writePackDir(
      manifestBody({ schemaVersion: 1, egressHosts: ["other.example.com"] }),
    );
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* expectFailure(
      "versionAlreadyApproved",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );

    // The approved row was untouched — still the original manifest.
    const listed = yield* svc.list({});
    assert.deepEqual(listed.packs[0]?.manifest.egressHosts, ["packs.example.com"]);
    assert.equal(listed.packs[0]?.packId, pack.packId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects an archived-version revive whose content differs from the pin", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { pack } = yield* installPack;
    yield* svc.uninstall({ packId: pack.packId });

    // Reinstalling the same version revives it — but only with identical
    // bytes. Different content is not a revive, it's a pin overwrite.
    const dir = yield* writePackDir(
      manifestBody({ schemaVersion: 1, egressHosts: ["other.example.com"] }),
    );
    const { request } = yield* svc.requestInstall({
      origin: { kind: "localPath", path: dir },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* expectFailure(
      "versionAlreadyApproved",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );

    const archived = yield* svc.list({ includeArchived: true });
    assert.isNotNull(archived.packs[0]?.archivedAt ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a cancel landing mid-confirm refuses with requestNotPending and rolls back", () => {
  let fetches = 0;
  let sqlClient: SqlClient.SqlClient | undefined;
  const layer = layerTestWithFetch(
    stubFetch({
      get: () =>
        Effect.gen(function* () {
          fetches += 1;
          if (fetches === 2 && sqlClient !== undefined) {
            // The human cancelled while confirm was re-fetching the origin.
            yield* sqlClient`
              UPDATE watch_connector_install_requests
              SET status = 'cancelled', resolved_at = '2025-01-01T00:00:00Z'
              WHERE status = 'pending'
            `;
          }
          return okResponse(wireBundle());
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WatchConnectorError({
                reason: "fetchFailed",
                message: "Interleaved cancel failed.",
                cause,
              }),
          ),
        ),
    }),
  );
  return Effect.gen(function* () {
    sqlClient = yield* SqlClient.SqlClient;
    const svc = yield* ConnectorService.ConnectorService;
    const sql = yield* SqlClient.SqlClient;
    const { request } = yield* svc.requestInstall({
      origin: { kind: "httpsUrl", url: "https://packs.example.com/pack.json" },
    });
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* expectFailure(
      "requestNotPending",
      svc.confirmInstall({ requestId: request.id, confirmationToken }),
    );

    // The write transaction rolled back with the guard: no pack approved,
    // and the cancelled status the human chose was not overwritten.
    assert.equal((yield* svc.list({})).packs.length, 0);
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM watch_connector_install_requests
      WHERE request_id = ${request.id}
    `;
    assert.equal(rows[0]?.status, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("prepare refuses when the request was cancelled during the deferred fetch", () => {
  let sqlClient: SqlClient.SqlClient | undefined;
  const layer = layerTestWithFetch(
    stubFetch({
      resolve: () => Effect.succeed([{ address: "10.0.0.7", family: 4 }]),
      get: () =>
        Effect.gen(function* () {
          // A cancel lands while prepare's private fetch is in flight.
          if (sqlClient !== undefined) {
            yield* sqlClient`
              UPDATE watch_connector_install_requests
              SET status = 'cancelled', resolved_at = '2025-01-01T00:00:00Z'
              WHERE status = 'pending'
            `;
          }
          return okResponse(wireBundle());
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WatchConnectorError({
                reason: "fetchFailed",
                message: "Interleaved cancel failed.",
                cause,
              }),
          ),
        ),
    }),
  );
  return Effect.gen(function* () {
    sqlClient = yield* SqlClient.SqlClient;
    const svc = yield* ConnectorService.ConnectorService;
    const sql = yield* SqlClient.SqlClient;
    const { request } = yield* svc.requestInstall({
      origin: { kind: "httpsUrl", url: "https://internal.example.net/pack.json" },
    });
    assert.isTrue(request.localUrl);
    yield* expectFailure(
      "requestNotPending",
      svc.prepareInstallConfirm({ requestId: request.id, allowLocalUrl: true }),
    );

    // The resolved row was not mutated by the fetch results.
    const rows = yield* sql<{ readonly manifest_json: string | null; readonly status: string }>`
      SELECT manifest_json, status
      FROM watch_connector_install_requests
      WHERE request_id = ${request.id}
    `;
    assert.equal(rows[0]?.status, "cancelled");
    assert.isNull(rows[0]?.manifest_json);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "uninstall cancels a deferred request whose origin could serve the pack, and purge deletes it",
  () => {
    const url = "https://packs.example.com/pack.json";
    let resolves = 0;
    const layer = layerTestWithFetch(
      stubFetch({
        resolve: () =>
          Effect.sync(() => {
            resolves += 1;
            // Public for the install request/fetch/confirm refetch (three
            // resolves), private afterwards — the same URL then classifies
            // as a deferred (local_url) request.
            return [{ address: resolves <= 3 ? "93.184.216.34" : "10.0.0.7", family: 4 as const }];
          }),
        get: () => Effect.succeed(okResponse(wireBundle())),
      }),
    );
    return Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const sql = yield* SqlClient.SqlClient;
      const { request } = yield* svc.requestInstall({ origin: { kind: "httpsUrl", url } });
      const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
      const { pack } = yield* svc.confirmInstall({
        requestId: request.id,
        confirmationToken: prepared.confirmationToken,
      });

      // A deferred install request to the URL this pack was approved from —
      // pack_id is NULL until prepare fetches it, so pack-scoped
      // cancellation alone can never see it.
      const deferred = yield* svc.requestInstall({ origin: { kind: "httpsUrl", url } });
      assert.isTrue(deferred.request.localUrl);
      assert.isNull(deferred.request.packId);

      yield* svc.uninstall({ packId: pack.packId });
      const afterUninstall = yield* sql<{ readonly status: string }>`
        SELECT status FROM watch_connector_install_requests
        WHERE request_id = ${deferred.request.id}
      `;
      assert.equal(afterUninstall[0]?.status, "cancelled");

      // Purge's "request history" claim now covers the deferred row too.
      const purgePrep = yield* svc.preparePurge({ packId: pack.packId });
      yield* svc.purgeInstanceData({
        packId: pack.packId,
        confirmationToken: purgePrep.confirmationToken,
      });
      const remaining = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM watch_connector_install_requests
      `;
      assert.equal(remaining[0]?.n, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("caps pending install requests per pack", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const dir = yield* writePackDir(manifestBody());
    for (let i = 0; i < 10; i++) {
      yield* svc.requestInstall({ origin: { kind: "localPath", path: dir } });
    }
    yield* expectFailure(
      "watchLimitExceeded",
      svc.requestInstall({ origin: { kind: "localPath", path: dir } }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recordHealth merges deltas so a poller write cannot erase lastRollback", () =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const { instance, request } = yield* upgradeToV2();
    const { confirmationToken } = yield* svc.prepareInstallConfirm({ requestId: request.id });
    yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });
    const { instance: rolled } = yield* svc.rollback({
      instanceId: instance.id,
      schemaVersion: 1,
    });
    assert.equal(rolled.health.lastRollback?.toSchemaVersion, 1);

    // A poller-shaped write — the delta carries no lastRollback — must not
    // erase the audit record, and fields it doesn't name keep their values.
    yield* svc.recordHealth(instance.id, {
      status: "healthy",
      lastError: null,
      lastFetchAt: "2025-06-01T00:00:00Z",
      consecutiveFailures: 0,
    });

    const { instances } = yield* svc.list({});
    const current = instances.find((row) => row.id === instance.id);
    assert.equal(current?.health.status, "healthy");
    assert.equal(current?.health.lastFetchAt, "2025-06-01T00:00:00Z");
    assert.equal(current?.health.lastRollback?.fromSchemaVersion, 2);
    assert.equal(current?.health.lastRollback?.toSchemaVersion, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recordHealth re-pushes when lastFetchAt crosses the coarse notify bucket", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const { pack } = yield* installPack;
      const { instance } = yield* svc.createInstance({
        packId: pack.packId,
        config: { repo: "t3" },
      });

      // Sliding(1) coalesces publishes made before the subscriber drains,
      // so each emitting write is paced on a gate its emission completes —
      // a wrong emit shifts the gate order and shows up in the payloads.
      const emissionIndex = yield* Ref.make(0);
      const gates = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
      const collected = yield* svc.subscribeList({}).pipe(
        Stream.tap(() =>
          Ref.getAndUpdate(emissionIndex, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n < gates.length ? Deferred.succeed(gates[n]!, undefined) : Effect.void,
            ),
          ),
        ),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(gates[0]!); // initial snapshot — subscription is live

      // A real health delta (status unknown → healthy): emits.
      yield* svc.recordHealth(instance.id, {
        status: "healthy",
        lastError: null,
        lastFetchAt: "2025-06-01T00:00:00Z",
        consecutiveFailures: 0,
      });
      yield* Deferred.await(gates[1]!);

      // Same 15-minute bucket, no field delta — must NOT emit.
      yield* svc.recordHealth(instance.id, { lastFetchAt: "2025-06-01T00:05:00Z" });
      // Bucket crossing (the 00:15 boundary): emits.
      yield* svc.recordHealth(instance.id, { lastFetchAt: "2025-06-01T00:20:00Z" });
      yield* Deferred.await(gates[2]!);

      // Same bucket as the crossing — must NOT emit.
      yield* svc.recordHealth(instance.id, { lastFetchAt: "2025-06-01T00:25:00Z" });
      // Real deltas emit.
      yield* svc.recordHealth(instance.id, { status: "unhealthy", lastError: "boom" });
      yield* Deferred.await(gates[3]!);
      yield* svc.recordHealth(instance.id, { status: "healthy", lastError: null });
      yield* Deferred.await(gates[4]!);

      const emissions = yield* Fiber.join(collected);
      const healthAt = (index: number) =>
        emissions[index]?.instances.find((row) => row.id === instance.id)?.health;
      assert.equal(emissions.length, 5);
      assert.equal(healthAt(1)?.lastFetchAt, "2025-06-01T00:00:00Z");
      // If the in-bucket +5m write had emitted, this slot would carry it.
      assert.equal(healthAt(2)?.lastFetchAt, "2025-06-01T00:20:00Z");
      assert.equal(healthAt(3)?.status, "unhealthy");
      assert.equal(healthAt(3)?.lastError, "boom");
      assert.equal(healthAt(3)?.lastFetchAt, "2025-06-01T00:25:00Z");
      assert.equal(healthAt(4)?.status, "healthy");
    }),
  ).pipe(Effect.provide(layerTest)),
);

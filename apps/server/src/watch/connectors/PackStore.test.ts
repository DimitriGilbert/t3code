import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  WatchConnectorError,
  WatchConnectorPackId,
  type WatchConnectorErrorReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as PackStore from "./PackStore.ts";

const PUBLIC_ADDRESS: PackStore.PackFetchAddress = { address: "93.184.216.34", family: 4 };

const manifest = (overrides?: Record<string, unknown>) => ({
  id: "pack.test",
  schemaVersion: 1,
  operations: [],
  egressHosts: ["packs.example.com"],
  secretKeys: [],
  transport: "http",
  ...overrides,
});

const wireBundle = (manifestBody: unknown = manifest(), files: Record<string, string> = {}) =>
  JSON.stringify({ manifest: manifestBody, files: { "fetch.ts": "void 0", ...files } });

const layerFetch = (handlers: {
  readonly resolve?: (
    host: string,
  ) => Effect.Effect<ReadonlyArray<PackStore.PackFetchAddress>, WatchConnectorError>;
  readonly get?: (
    url: string,
    addresses: ReadonlyArray<PackStore.PackFetchAddress>,
  ) => Effect.Effect<PackStore.PackFetchResponse, WatchConnectorError>;
}) =>
  Layer.succeed(PackStore.ConnectorPackFetch, {
    resolve: handlers.resolve ?? (() => Effect.succeed([PUBLIC_ADDRESS])),
    get: handlers.get ?? (() => Effect.die(new Error("pack fetch should not have been called"))),
  });

const okResponse = (body: string): PackStore.PackFetchResponse => ({
  status: 200,
  location: null,
  body: new TextEncoder().encode(body),
});

const isConnectorError = Schema.is(WatchConnectorError);

const expectConnectorError = <A, R>(
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

const urlOrigin = (url: string, allowLocalUrl?: boolean) => ({
  url,
  ...(allowLocalUrl === undefined ? {} : { allowLocalUrl }),
});

it("flags loopback, private, link-local, and translated ranges as local", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "169.254.1.1", "192.168.1.1", "0.0.0.0"]) {
    assert.isTrue(PackStore.isLocalAddress(address, 4), `${address} should be local`);
  }
  for (const address of ["::1", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
    assert.isTrue(PackStore.isLocalAddress(address, 6), `${address} should be local`);
  }
  for (const address of ["93.184.216.34", "8.8.8.8"]) {
    assert.isFalse(PackStore.isLocalAddress(address, 4), `${address} should be public`);
  }
});

it.effect("rejects a non-https pack URL before any fetch", () =>
  expectConnectorError(
    "urlBlocked",
    PackStore.fetchUrlBundle({ url: "http://packs.example.com/pack.json" }),
  ).pipe(Effect.provide(layerFetch({}))),
);

it.effect("rejects a URL resolving to a private address without fetching", () =>
  Effect.gen(function* () {
    let fetched = false;
    const layer = layerFetch({
      resolve: () => Effect.succeed([{ address: "10.0.0.7", family: 4 }]),
      get: () =>
        Effect.sync(() => {
          fetched = true;
          return okResponse(wireBundle());
        }),
    });
    yield* expectConnectorError(
      "urlBlocked",
      PackStore.fetchUrlBundle({ url: "https://packs.example.com/pack.json" }).pipe(
        Effect.provide(layer),
      ),
    );
    assert.isFalse(fetched);
  }),
);

it.effect("honours an explicit allowLocalUrl for a loopback URL", () =>
  Effect.gen(function* () {
    const bundle = yield* PackStore.fetchUrlBundle(
      urlOrigin("https://127.0.0.1:8443/pack.json", true),
    ).pipe(
      Effect.provide(
        layerFetch({
          resolve: () => Effect.succeed([{ address: "127.0.0.1", family: 4 }]),
          get: () => Effect.succeed(okResponse(wireBundle())),
        }),
      ),
    );
    assert.equal(bundle.manifest.id, "pack.test");
    assert.match(bundle.contentHash, /^[0-9a-f]{64}$/);
    assert.match(bundle.manifestHash, /^[0-9a-f]{64}$/);
    assert.isString(bundle.files["manifest.json"]);
  }),
);

it.effect("re-validates every redirect target — a redirect to a private host is refused", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const layer = layerFetch({
      resolve: (host) =>
        Effect.succeed([
          host === "packs.example.com" ? PUBLIC_ADDRESS : { address: "192.168.0.9", family: 4 },
        ]),
      get: (url) => {
        seen.push(url);
        return Effect.succeed(
          url === "https://packs.example.com/pack.json"
            ? {
                status: 302,
                location: "https://internal.example.net/pack.json",
                body: new Uint8Array(),
              }
            : okResponse(wireBundle()),
        );
      },
    });
    yield* expectConnectorError(
      "urlBlocked",
      PackStore.fetchUrlBundle(urlOrigin("https://packs.example.com/pack.json")).pipe(
        Effect.provide(layer),
      ),
    );
    // The first request ran; the redirected request never did.
    assert.deepEqual(seen, ["https://packs.example.com/pack.json"]);
  }),
);

it.effect("rejects a redirect that downgrades to http", () =>
  Effect.gen(function* () {
    const layer = layerFetch({
      get: () =>
        Effect.succeed({
          status: 301,
          location: "http://packs.example.com/pack.json",
          body: new Uint8Array(),
        }),
    });
    yield* expectConnectorError(
      "urlBlocked",
      PackStore.fetchUrlBundle(urlOrigin("https://packs.example.com/pack.json")).pipe(
        Effect.provide(layer),
      ),
    );
  }),
);

it.effect("reads a local pack directory and pins its content hash", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pack-store-" });
      yield* fs.writeFileString(path.join(dir, "manifest.json"), JSON.stringify(manifest()));
      yield* fs.writeFileString(path.join(dir, "fetch.ts"), "export default 1");
      const bundle = yield* PackStore.readLocalBundle(dir);
      assert.equal(bundle.manifest.id, "pack.test");
      assert.equal(bundle.files["fetch.ts"], "export default 1");
      assert.match(bundle.contentHash, /^[0-9a-f]{64}$/);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!symlinksSupported)(
  "refuses a pack file that links outside the pack directory",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const packDir = yield* fs.makeTempDirectoryScoped({ prefix: "pack-store-" });
        const outsideDir = yield* fs.makeTempDirectoryScoped({ prefix: "pack-outside-" });
        yield* fs.writeFileString(path.join(packDir, "manifest.json"), JSON.stringify(manifest()));
        yield* fs.writeFileString(path.join(outsideDir, "secret.ts"), "exfil");
        yield* fs.symlink(path.join(outsideDir, "secret.ts"), path.join(packDir, "fetch.ts"));
        yield* expectConnectorError("invalidOrigin", PackStore.readLocalBundle(packDir));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("materializes under the pinned hash and re-verifies it on load", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const packDir = yield* fs.makeTempDirectoryScoped({ prefix: "pack-store-" });
      yield* fs.writeFileString(path.join(packDir, "manifest.json"), JSON.stringify(manifest()));
      yield* fs.writeFileString(path.join(packDir, "fetch.ts"), "export default 1");
      const bundle = yield* PackStore.readLocalBundle(packDir);

      const dir = yield* PackStore.materializeBundle(bundle);
      assert.include(dir, config.connectorsDir);
      assert.include(dir, bundle.contentHash);

      const loaded = yield* PackStore.loadInstalled(
        WatchConnectorPackId.make("pack.test"),
        bundle.contentHash,
      );
      assert.equal(loaded.contentHash, bundle.contentHash);

      // Tamper with the installed code: reload must refuse it.
      yield* fs.writeFileString(path.join(dir, "fetch.ts"), "export default 2");
      yield* expectConnectorError(
        "hashMismatch",
        PackStore.loadInstalled(WatchConnectorPackId.make("pack.test"), bundle.contentHash),
      );
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "pack-store-config-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("removeInstalled deletes every pinned version directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const packDir = yield* fs.makeTempDirectoryScoped({ prefix: "pack-store-" });
      yield* fs.writeFileString(path.join(packDir, "manifest.json"), JSON.stringify(manifest()));
      yield* fs.writeFileString(path.join(packDir, "fetch.ts"), "export default 1");
      const bundle = yield* PackStore.readLocalBundle(packDir);
      yield* PackStore.materializeBundle(bundle);

      yield* PackStore.removeInstalled(WatchConnectorPackId.make("pack.test"));
      const gone = yield* fs.exists(path.join(config.connectorsDir, "pack.test"));
      assert.isFalse(gone);
      // A second call is a no-op, not an error.
      yield* PackStore.removeInstalled(WatchConnectorPackId.make("pack.test"));
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "pack-store-config-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

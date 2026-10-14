// @effect-diagnostics nodeBuiltinImport:off - the private-range blocklist and
// DNS-pinned connections need node builtins (same posture as
// htmlRender/publicProxy.ts).
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  WatchConnectorError,
  type WatchConnectorErrorReason,
  WatchConnectorPackManifest,
  type WatchConnectorOrigin,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClientRequest } from "effect/http";

import * as ServerConfig from "../../config.ts";

/**
 * Pack layout: a directory holding `manifest.json` plus the pack's UTF-8
 * source files. A local install reads such a directory verbatim. A URL
 * install fetches one JSON document `{manifest, files: {<relPath>: source>}}`
 * — the same bundle in wire form, with `manifest.json` synthesized from the
 * decoded manifest so both origins produce the same file set and the same
 * content hash.
 *
 * Installed packs live under `<stateDir>/connectors/<packId>/<contentHash>/`.
 * The hash is the pin: every read back re-hashes the stored files and a
 * mismatch refuses to hand out code.
 */

export const MAX_PACK_FILES = 128;
export const MAX_PACK_FILE_BYTES = 512 * 1024;
export const MAX_PACK_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;
const FETCH_TIMEOUT = "30 seconds";

export interface ConnectorPackBundle {
  readonly manifest: WatchConnectorPackManifest;
  /** Pack sources by POSIX relative path; `manifest.json` is always present. */
  readonly files: Readonly<Record<string, string>>;
  /** SHA-256 hex over the canonical file set — the pin installs record. */
  readonly contentHash: string;
  /** SHA-256 hex of the stored `manifest.json` — what confirmation tokens bind. */
  readonly manifestHash: string;
}

const connectorError = (
  reason: WatchConnectorErrorReason,
  message: string,
  options?: { readonly cause?: unknown },
) =>
  new WatchConnectorError({
    message,
    reason,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

/** Stable byte identity of a file set: sorted names, NUL-separated. */
export const hashPackFiles = (files: Readonly<Record<string, string>>): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(files[name]!, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
};

const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

// The canonical manifest bytes: fromJsonString's encode side writes the
// manifest as a JSON string, so manifest.json and its hash are byte-stable.
const ManifestJsonCodec = Schema.fromJsonString(WatchConnectorPackManifest);
const encodeManifestJson = Schema.encodeSync(ManifestJsonCodec);
const decodeManifestJson = Schema.decodeEffect(ManifestJsonCodec);
const decodeManifest = Schema.decodeUnknownEffect(WatchConnectorPackManifest);
const isConnectorError = Schema.is(WatchConnectorError);
const UnknownJsonCodec = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeEffect(UnknownJsonCodec);

const manifestFields = (
  manifest: WatchConnectorPackManifest,
): { manifestJson: string; manifestHash: string } => {
  const manifestJson = encodeManifestJson(manifest);
  return { manifestJson, manifestHash: sha256Hex(manifestJson) };
};

/**
 * Only POSIX relative paths inside the pack dir are pack files. Anything that
 * would escape (absolute, `..`, drive letters, backslashes) or fuzz the layout
 * is rejected — pack file keys cross trust boundaries on URL installs.
 */
const isSafePackPath = (relativePath: string): boolean => {
  if (relativePath.length === 0 || relativePath.length > 512) return false;
  if (relativePath.includes("\\") || relativePath.includes("\0")) return false;
  if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) return false;
  return !relativePath.split("/").some((segment) => segment === ".." || segment === "");
};

const makeBundle = (
  manifest: WatchConnectorPackManifest,
  files: Readonly<Record<string, string>>,
): ConnectorPackBundle => {
  const { manifestJson, manifestHash } = manifestFields(manifest);
  const allFiles = { ...files, "manifest.json": manifestJson };
  return {
    manifest,
    files: allFiles,
    contentHash: hashPackFiles(allFiles),
    manifestHash,
  };
};

// ── Local-path installs ──────────────────────────────────────────────────

/** Reads a pack directory into a normalized bundle. Symlinks are refused: an
 * install origin must not reach outside its own directory. */
export const readLocalBundle = Effect.fn("ConnectorPackStore.readLocalBundle")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(directory);
  const realRoot = yield* fs
    .realPath(root)
    .pipe(
      Effect.mapError((cause) =>
        connectorError("invalidOrigin", `Could not resolve pack directory ${directory}.`, {
          cause,
        }),
      ),
    );

  const entries = yield* fs
    .readDirectory(root, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        connectorError("invalidOrigin", `Could not read pack directory ${directory}.`, { cause }),
      ),
    );

  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    // realPath follows every symlink segment, so a link — or a linked
    // directory — reaching outside the pack dir is caught here.
    const realEntry = yield* fs
      .realPath(fullPath)
      .pipe(
        Effect.mapError((cause) =>
          connectorError("invalidOrigin", `Could not resolve ${entry} in pack directory.`, {
            cause,
          }),
        ),
      );
    if (realEntry !== realRoot && !realEntry.startsWith(`${realRoot}${path.sep}`)) {
      return yield* connectorError(
        "invalidOrigin",
        `Pack entry ${entry} links outside the pack directory.`,
      );
    }
    const stat = yield* fs
      .stat(fullPath)
      .pipe(
        Effect.mapError((cause) =>
          connectorError("invalidOrigin", `Could not stat ${entry} in pack directory.`, { cause }),
        ),
      );
    if (stat.type === "Directory") continue;
    if (stat.type !== "File") {
      return yield* connectorError(
        "invalidOrigin",
        `Pack entry ${entry} is not a regular file; pack directories may not contain links or special files.`,
      );
    }
    if (!isSafePackPath(entry)) {
      return yield* connectorError(
        "invalidOrigin",
        `Pack entry ${entry} is not a safe relative path.`,
      );
    }
    const content = yield* fs
      .readFileString(realEntry)
      .pipe(
        Effect.mapError((cause) =>
          connectorError("invalidOrigin", `Could not read ${entry} in pack directory.`, { cause }),
        ),
      );
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_PACK_FILE_BYTES) {
      return yield* connectorError(
        "invalidOrigin",
        `Pack file ${entry} exceeds the ${MAX_PACK_FILE_BYTES}-byte file limit.`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PACK_BUNDLE_BYTES) {
      return yield* connectorError(
        "invalidOrigin",
        `Pack directory exceeds the ${MAX_PACK_BUNDLE_BYTES}-byte bundle limit.`,
      );
    }
    if (Object.keys(files).length >= MAX_PACK_FILES) {
      return yield* connectorError(
        "invalidOrigin",
        `Pack directory exceeds the ${MAX_PACK_FILES}-file limit.`,
      );
    }
    files[entry] = content;
  }

  const manifestText = files["manifest.json"];
  if (manifestText === undefined) {
    return yield* connectorError(
      "invalidOrigin",
      `Pack directory ${directory} has no manifest.json.`,
    );
  }
  const manifest = yield* decodeManifestJson(manifestText).pipe(
    Effect.mapError((cause) =>
      connectorError(
        "manifestInvalid",
        "Pack manifest.json does not match the pack manifest schema.",
        { cause },
      ),
    ),
  );
  // The raw manifest.json bytes stay in the file set, so the content hash
  // pins exactly what was on disk; manifestHash binds tokens to the decoded,
  // canonically-encoded manifest.
  const { manifestHash } = manifestFields(manifest);
  return {
    manifest,
    files,
    contentHash: hashPackFiles(files),
    manifestHash,
  } satisfies ConnectorPackBundle;
});

// ── Private-range blocking ───────────────────────────────────────────────
// Same block list as htmlRender/publicProxy.ts: this machine and its local
// networks are never a pack origin.

const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// IPv6 ranges that carry an IPv4 a translator may route to without checking
// it: IPv4-compatible, local-use NAT64, and Teredo. The IPv4-mapped range is
// deliberately NOT here — Node's BlockList lets an `::ffff:` subnet match
// every IPv4 check, so it lives in its own list below.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const IPV4_MAPPED = new NodeNet.BlockList();
IPV4_MAPPED.addSubnet("::ffff:0.0.0.0", 96, "ipv6");
const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The IPv4 address a NAT64 or 6to4 address stands for, which a translator
 * will route to, so it is checked as well.
 */
const embeddedIPv4 = (address: string) => {
  const at = IPV4_MAPPED.check(address, "ipv6")
    ? 6
    : NAT64.check(address, "ipv6")
      ? 6
      : SIX_TO_FOUR.check(address, "ipv6")
        ? 1
        : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/** The addresses this machine's interfaces hold right now. */
const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

/**
 * Whether `address` is local to this machine or a private/link-local/
 * loopback range — the set a pack URL may never reach without an explicit
 * `allowLocalUrl` on the request.
 */
export const isLocalAddress = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocalAddress(embedded, 4);
};

// ── URL fetch seam ───────────────────────────────────────────────────────

export interface PackFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PackFetchResponse {
  readonly status: number;
  readonly location: string | null;
  readonly body: Uint8Array;
}

/**
 * How the server talks to a pack origin URL. `get` performs exactly one
 * request — redirects are never followed internally — and connects only to
 * `addresses`, the list the caller resolved and checked, so a name that
 * re-resolves to something else later (DNS rebinding) changes nothing.
 */
export class ConnectorPackFetch extends Context.Service<
  ConnectorPackFetch,
  {
    readonly resolve: (
      host: string,
    ) => Effect.Effect<ReadonlyArray<PackFetchAddress>, WatchConnectorError>;
    readonly get: (
      url: string,
      addresses: ReadonlyArray<PackFetchAddress>,
    ) => Effect.Effect<PackFetchResponse, WatchConnectorError>;
  }
>()("t3/watch/connectors/PackStore/ConnectorPackFetch") {}

const packFetchFailure = (message: string, cause?: unknown) =>
  connectorError("fetchFailed", message, cause === undefined ? {} : { cause });

const resolveHost = (host: string) =>
  Effect.gen(function* () {
    const literalFamily = NodeNet.isIP(host);
    if (literalFamily === 4 || literalFamily === 6) {
      const entry: PackFetchAddress = { address: host, family: literalFamily };
      return [entry];
    }
    const addresses = yield* Effect.tryPromise({
      try: () => NodeDnsPromises.lookup(host, { all: true, verbatim: true }),
      catch: (cause) => packFetchFailure(`Could not resolve ${host}.`, cause),
    });
    return addresses.map((entry): PackFetchAddress => ({
      address: entry.address,
      family: entry.family === 6 ? 6 : 4,
    }));
  });

/** One GET whose socket lookup is pinned to `addresses` — the list already range-checked by the caller. */
const pinnedGet = (url: string, addresses: ReadonlyArray<PackFetchAddress>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const agent = yield* NodeHttpClient.makeAgent({
        lookup: (_host, options, callback) => {
          if (addresses.length === 0) {
            callback(new Error("No checked addresses for pack fetch."), "", 0);
            return;
          }
          if (options.all) {
            callback(
              null,
              addresses.map((a) => ({ address: a.address, family: a.family })),
            );
            return;
          }
          callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      });
      const httpClient = yield* NodeHttpClient.makeNodeHttp.pipe(
        Effect.provideService(NodeHttpClient.HttpAgent, agent),
      );
      const response = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
        Effect.mapError((cause) => packFetchFailure(`Pack fetch failed for ${url}.`, cause)),
        Effect.timeout(FETCH_TIMEOUT),
        Effect.mapError((cause) => packFetchFailure(`Pack fetch failed for ${url}.`, cause)),
      );

      // Collect at most one chunk past the cap, then stop pulling: an
      // oversized bundle is rejected whole, never truncated.
      let size = 0;
      const parts = yield* Stream.runCollect(
        response.stream.pipe(
          Stream.takeWhile((chunk) => {
            const underCap = size <= MAX_PACK_BUNDLE_BYTES;
            size += chunk.byteLength;
            return underCap;
          }),
        ),
      ).pipe(Effect.mapError((cause) => packFetchFailure(`Could not read pack response.`, cause)));
      if (size > MAX_PACK_BUNDLE_BYTES) {
        return yield* packFetchFailure(
          `Pack bundle exceeds the ${MAX_PACK_BUNDLE_BYTES}-byte limit.`,
        );
      }
      return {
        status: response.status,
        location: response.headers.location ?? null,
        body: Uint8Array.from(Buffer.concat(parts.map((chunk) => Buffer.from(chunk)))),
      } satisfies PackFetchResponse;
    }),
  );

export const layerPackFetch = Layer.succeed(ConnectorPackFetch, {
  resolve: resolveHost,
  get: pinnedGet,
});

// ── URL installs ─────────────────────────────────────────────────────────

const UrlBundleWire = Schema.Struct({
  manifest: Schema.Unknown,
  files: Schema.Record(Schema.String, Schema.String),
});
const decodeUrlBundleWire = Schema.decodeUnknownEffect(UrlBundleWire);

/** Fetches + normalizes a URL pack bundle. Every hop — including each
 * redirect target — is re-validated as https and range-checked, so a redirect
 * can never smuggle a request to a private address. */
export const fetchUrlBundle = Effect.fn("ConnectorPackStore.fetchUrlBundle")(function* (origin: {
  readonly url: string;
  readonly allowLocalUrl?: boolean;
}) {
  const fetch = yield* ConnectorPackFetch;
  const allowLocal = origin.allowLocalUrl === true;
  let target = origin.url;

  for (let hop = 0; ; hop += 1) {
    const parsed = yield* Effect.try({
      try: () => new URL(target),
      catch: (cause) =>
        connectorError("invalidOrigin", `Pack URL ${target} is not a valid URL.`, { cause }),
    });
    if (parsed.protocol !== "https:") {
      return yield* connectorError(
        "urlBlocked",
        `Pack URL ${target} is not https; only https pack URLs are allowed.`,
      );
    }
    const host = parsed.hostname.toLowerCase();
    const addresses = yield* fetch.resolve(host);
    if (addresses.length === 0) {
      return yield* packFetchFailure(`Pack URL host ${host} does not resolve.`);
    }
    if (!allowLocal && addresses.some(({ address, family }) => isLocalAddress(address, family))) {
      return yield* connectorError(
        "urlBlocked",
        `Pack URL host ${host} resolves to a loopback, link-local, or private address.`,
      );
    }
    const response = yield* fetch.get(target, addresses);
    const status = response.status;
    if (status >= 300 && status < 400 && response.location !== null) {
      if (hop >= MAX_REDIRECT_HOPS) {
        return yield* packFetchFailure(`Pack URL ${origin.url} redirected too many times.`);
      }
      target = yield* Effect.try({
        try: () => new URL(response.location!, target).toString(),
        catch: (cause) =>
          packFetchFailure(`Pack URL ${origin.url} redirected to an invalid location.`, cause),
      });
      continue;
    }
    if (status !== 200) {
      return yield* packFetchFailure(`Pack URL ${origin.url} answered ${status}.`);
    }

    const parsedBody = yield* decodeUnknownJson(Buffer.from(response.body).toString("utf8")).pipe(
      Effect.mapError((cause) =>
        connectorError(
          "manifestInvalid",
          `Pack URL ${origin.url} did not return a valid JSON bundle.`,
          { cause },
        ),
      ),
    );
    const wire = yield* decodeUrlBundleWire(parsedBody).pipe(
      Effect.mapError((cause) =>
        connectorError(
          "manifestInvalid",
          `Pack URL ${origin.url} did not return a {manifest, files} bundle.`,
          { cause },
        ),
      ),
    );
    if (Object.keys(wire.files).length > MAX_PACK_FILES) {
      return yield* connectorError(
        "manifestInvalid",
        `Pack bundle exceeds the ${MAX_PACK_FILES}-file limit.`,
      );
    }
    let totalBytes = 0;
    for (const [name, content] of Object.entries(wire.files)) {
      if (!isSafePackPath(name) || name === "manifest.json") {
        return yield* connectorError(
          "manifestInvalid",
          `Pack bundle carries an invalid file path "${name}".`,
        );
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_PACK_FILE_BYTES) {
        return yield* connectorError(
          "manifestInvalid",
          `Pack file ${name} exceeds the ${MAX_PACK_FILE_BYTES}-byte file limit.`,
        );
      }
      totalBytes += bytes;
      if (totalBytes > MAX_PACK_BUNDLE_BYTES) {
        return yield* connectorError(
          "manifestInvalid",
          `Pack bundle exceeds the ${MAX_PACK_BUNDLE_BYTES}-byte file limit.`,
        );
      }
    }
    const manifest = yield* decodeManifest(wire.manifest).pipe(
      Effect.mapError((cause) =>
        connectorError("manifestInvalid", "Pack bundle manifest does not match the schema.", {
          cause,
        }),
      ),
    );
    return makeBundle(manifest, wire.files);
  }
});

/**
 * Whether an https pack URL resolves to a loopback/link-local/private
 * address. Used to classify a request origin without fetching it: a local
 * URL is recorded deferred, so the agent-reachable request leg can never
 * trigger a private-range fetch — only the human confirm path can.
 */
export const urlResolvesLocal = Effect.fn("ConnectorPackStore.urlResolvesLocal")(function* (
  url: string,
) {
  const fetch = yield* ConnectorPackFetch;
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: (cause) =>
      connectorError("invalidOrigin", `Pack URL ${url} is not a valid URL.`, { cause }),
  });
  if (parsed.protocol !== "https:") {
    return yield* connectorError(
      "urlBlocked",
      `Pack URL ${url} is not https; only https pack URLs are allowed.`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const addresses = yield* fetch.resolve(host);
  if (addresses.length === 0) {
    return yield* packFetchFailure(`Pack URL host ${host} does not resolve.`);
  }
  return addresses.some(({ address, family }) => isLocalAddress(address, family));
});

// ── Installed pack storage ───────────────────────────────────────────────

const packDirName = (packId: string) => packId.replace(/[^A-Za-z0-9._-]/g, "_");

const installedPackDir = Effect.fn(function* (packId: string, contentHash: string) {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.connectorsDir, packDirName(packId), contentHash);
});

/** Fetch the bundle for an install origin: local directory or https URL. */
export const fetchOrigin = Effect.fn("ConnectorPackStore.fetchOrigin")(function* (
  origin: WatchConnectorOrigin,
) {
  if (origin.kind === "localPath") {
    return yield* readLocalBundle(origin.path);
  }
  return yield* fetchUrlBundle(origin);
});

/**
 * Writes a fetched bundle under the pinned hash — `<connectorsDir>/<packId>/<contentHash>/`.
 * A re-materialization of identical bytes is idempotent.
 */
export const materializeBundle = Effect.fn("ConnectorPackStore.materializeBundle")(function* (
  bundle: ConnectorPackBundle,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* installedPackDir(bundle.manifest.id, bundle.contentHash);
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        connectorError("fetchFailed", `Could not create pack directory ${dir}.`, { cause }),
      ),
    );
  for (const [name, content] of Object.entries(bundle.files)) {
    const target = path.join(dir, name);
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          connectorError("fetchFailed", `Could not create pack directory for ${name}.`, { cause }),
        ),
      );
    yield* fs
      .writeFileString(target, content)
      .pipe(
        Effect.mapError((cause) =>
          connectorError("fetchFailed", `Could not write pack file ${name}.`, { cause }),
        ),
      );
  }
  return dir;
});

/**
 * Reads an installed pack back — and re-verifies it. The stored files are
 * re-hashed on every read so tampered or corrupted pack code is refused
 * rather than run; the same check runs wherever pack content is refetched.
 */
export const loadInstalled = Effect.fn("ConnectorPackStore.loadInstalled")(function* (
  packId: string,
  contentHash: string,
) {
  const dir = yield* installedPackDir(packId, contentHash);
  const bundle = yield* readLocalBundle(dir).pipe(
    Effect.mapError((cause) =>
      isConnectorError(cause)
        ? cause
        : connectorError("fetchFailed", `Could not read installed pack ${packId}.`, { cause }),
    ),
  );
  if (bundle.contentHash !== contentHash) {
    return yield* connectorError(
      "hashMismatch",
      `Installed pack ${packId} content hash no longer matches the approved pin.`,
    );
  }
  return bundle;
});

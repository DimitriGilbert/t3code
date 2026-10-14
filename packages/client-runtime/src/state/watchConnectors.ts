import type {
  WatchConnectorInstallRequest,
  WatchConnectorOrigin,
  WatchConnectorPackManifest,
  WatchConnectorTransport,
} from "@t3tools/contracts";

/**
 * Pure derivation for the connector install/upgrade confirm dialog — the
 * request row shows what a human is about to approve, and on upgrades the
 * pending manifest is diffed against the currently approved one. Web and
 * mobile share these.
 */

export interface WatchConnectorListDiff {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface WatchConnectorManifestDiff {
  /** Present only when the schema version moves. */
  readonly schemaVersion: { readonly from: number; readonly to: number } | null;
  readonly transport: {
    readonly from: WatchConnectorTransport;
    readonly to: WatchConnectorTransport;
  } | null;
  readonly egressHosts: WatchConnectorListDiff;
  readonly secretKeys: WatchConnectorListDiff;
  readonly operations: WatchConnectorListDiff;
}

function diffList(
  base: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): WatchConnectorListDiff {
  const baseSet = new Set(base);
  const nextSet = new Set(next);
  return {
    added: next.filter((entry) => !baseSet.has(entry)),
    removed: base.filter((entry) => !nextSet.has(entry)),
  };
}

/**
 * What the upgrade confirm dialog diffs: schema version, transport, declared
 * egress hosts, declared secret keys, and operation names. Unchanged fields
 * come back empty so the dialog lists only what moved.
 */
export function diffWatchConnectorManifests(
  base: WatchConnectorPackManifest,
  next: WatchConnectorPackManifest,
): WatchConnectorManifestDiff {
  return {
    schemaVersion:
      base.schemaVersion === next.schemaVersion
        ? null
        : { from: base.schemaVersion, to: next.schemaVersion },
    transport:
      base.transport === next.transport ? null : { from: base.transport, to: next.transport },
    egressHosts: diffList(base.egressHosts, next.egressHosts),
    secretKeys: diffList(base.secretKeys, next.secretKeys),
    operations: diffList(
      base.operations.map((operation) => operation.name),
      next.operations.map((operation) => operation.name),
    ),
  };
}

/**
 * Whether the confirm dialog gates its primary action behind the "I reviewed
 * what this pack can reach" acknowledgement. Only network origins are risky —
 * a `localPath` install needs no ceremony (the user pointed at a directory on
 * their own disk), while any https fetch — including a `localUrl` request
 * whose deferred fetch this acknowledgement also unlocks — gets the gate.
 */
export function watchInstallRequestNeedsReviewAck(
  request: Pick<WatchConnectorInstallRequest, "origin">,
): boolean {
  return request.origin.kind === "httpsUrl";
}

/**
 * The short origin label used wherever a pack or request is listed: the path
 * for local installs, the host for https origins (falling back to the raw URL
 * when it does not parse).
 */
export function watchConnectorOriginLabel(origin: WatchConnectorOrigin): string {
  if (origin.kind === "localPath") return origin.path;
  try {
    return new URL(origin.url).host;
  } catch {
    return origin.url;
  }
}

/**
 * Whether a pending request still needs its deferred fetch: `localUrl`
 * requests are recorded unfetched (null manifest/hash) until a human-acked
 * prepare step runs.
 */
export function watchInstallRequestIsUnfetched(
  request: Pick<WatchConnectorInstallRequest, "localUrl" | "manifest">,
): boolean {
  return request.localUrl && request.manifest === null;
}

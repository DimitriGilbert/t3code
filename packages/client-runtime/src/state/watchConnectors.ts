import type {
  WatchConnectorInstallRequest,
  WatchConnectorOrigin,
  WatchConnectorPackManifest,
  WatchConnectorTransport,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

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

export interface WatchConnectorOperationDescriptionDiff {
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface WatchConnectorWidgetDiff {
  readonly name: string;
  /** Present only when the same-named widget's pack-relative source file moved. */
  readonly file: { readonly from: string; readonly to: string } | null;
  readonly subscriptions: WatchConnectorListDiff;
  readonly actions: WatchConnectorListDiff;
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
  /** Same-name operations whose `description` text moved (added counts as a move). */
  readonly operationDescriptions: ReadonlyArray<WatchConnectorOperationDescriptionDiff>;
  readonly widgets: {
    readonly names: WatchConnectorListDiff;
    /** Same-name widgets whose declared bridge surface or source file moved. */
    readonly changed: ReadonlyArray<WatchConnectorWidgetDiff>;
  };
  /** The instance-config field schema was added, removed, or rewritten. */
  readonly authSchemaChanged: boolean;
  /**
   * Catch-all: the manifests differ somewhere the itemized groups do not
   * cover (today that is only `id`; any future manifest field lands here
   * automatically). The dialog renders one generic row for it so a real
   * surface move can never reduce to a bare `schemaVersion N → M`.
   */
  readonly surfaceChanged: boolean;
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
 * The manifest minus every field the diff itemizes, so the `surfaceChanged`
 * catch-all fires on anything left over — the pack id today, any contract
 * field added later — without double-reporting an itemized move.
 */
function surfaceResidue(manifest: WatchConnectorPackManifest): Record<string, unknown> {
  const {
    schemaVersion: _schemaVersion,
    transport: _transport,
    egressHosts: _egressHosts,
    secretKeys: _secretKeys,
    operations: _operations,
    widgets: _widgets,
    authSchema: _authSchema,
    ...residue
  } = manifest;
  return residue;
}

function isEmptyListDiff(diff: WatchConnectorListDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0;
}

/**
 * What the upgrade confirm dialog diffs: schema version, transport, declared
 * egress hosts, declared secret keys, operation names and descriptions,
 * bundled widgets (names, plus per-widget bridge subscriptions/actions and
 */
export function diffWatchConnectorManifests(
  base: WatchConnectorPackManifest,
  next: WatchConnectorPackManifest,
): WatchConnectorManifestDiff {
  const nextOperationsByName = new Map(
    next.operations.map((operation) => [operation.name, operation]),
  );
  const operationDescriptions = base.operations.flatMap((baseOperation) => {
    const nextOperation = nextOperationsByName.get(baseOperation.name);
    if (nextOperation === undefined) return [];
    const from = baseOperation.description ?? null;
    const to = nextOperation.description ?? null;
    return from === to ? [] : [{ name: baseOperation.name, from, to }];
  });

  const baseWidgets = base.widgets ?? [];
  const nextWidgetsByName = new Map((next.widgets ?? []).map((widget) => [widget.name, widget]));
  const widgetChanges = baseWidgets.flatMap((baseWidget) => {
    const nextWidget = nextWidgetsByName.get(baseWidget.name);
    if (nextWidget === undefined) return [];
    const subscriptions = diffList(
      baseWidget.bridge.subscriptions,
      nextWidget.bridge.subscriptions,
    );
    const actions = diffList(baseWidget.bridge.actions, nextWidget.bridge.actions);
    const file =
      baseWidget.file === nextWidget.file ? null : { from: baseWidget.file, to: nextWidget.file };
    if (file === null && isEmptyListDiff(subscriptions) && isEmptyListDiff(actions)) {
      return [];
    }
    return [{ name: baseWidget.name, file, subscriptions, actions }];
  });

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
    operationDescriptions,
    widgets: {
      names: diffList(
        baseWidgets.map((widget) => widget.name),
        (next.widgets ?? []).map((widget) => widget.name),
      ),
      changed: widgetChanges,
    },
    authSchemaChanged: !Equal.equals(base.authSchema ?? null, next.authSchema ?? null),
    surfaceChanged: !Equal.equals(surfaceResidue(base), surfaceResidue(next)),
  };
}

/**
 * Whether the confirm dialog gates its primary action behind the "I reviewed
 * what this pack can reach" acknowledgement. Only network origins are risky —
 * a `localPath` install needs no ceremony (the user pointed at a directory on
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

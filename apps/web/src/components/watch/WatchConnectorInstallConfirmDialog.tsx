import {
  diffWatchConnectorManifests,
  watchConnectorOriginLabel,
  watchInstallRequestIsUnfetched,
  watchInstallRequestNeedsReviewAck,
} from "@t3tools/client-runtime/state/watch-connectors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WatchConnectorInstallRequest,
  WatchConnectorPack,
  WatchConnectorPackManifest,
  WatchConnectorPackWidget,
  WatchConnectorPrepareInstallConfirmResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  CopyIcon,
  FolderOpenIcon,
  GlobeIcon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "~/components/ui/anchoredCopyToast";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { watchEnvironment } from "~/state/watch";

/**
 * The human gate for connector pack installs and upgrades. `Dialog`, one per
 * pending request:
 * - identity (pack id + origin), pinned content hash, declared egress hosts,
 */

function PermissionGroup(props: {
  readonly label: string;
  readonly entries: ReadonlyArray<string>;
  readonly icon: typeof GlobeIcon;
}) {
  const Icon = props.icon;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      {props.entries.length === 0 ? (
        <span className="text-xs text-muted-foreground">None declared</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {props.entries.map((entry) => (
            <Badge key={entry} size="sm" variant="outline">
              <Icon className="size-3" />
              {entry}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function ManifestDiffRows(props: {
  readonly diffBase: WatchConnectorPack;
  readonly manifest: WatchConnectorPackManifest;
}) {
  const diff = diffWatchConnectorManifests(props.diffBase.manifest, props.manifest);
  const rows: Array<{ key: string; added: boolean; text: string }> = [];
  if (diff.schemaVersion !== null) {
    rows.push({
      key: "schema",
      added: true,
      text: `schemaVersion ${diff.schemaVersion.from} → ${diff.schemaVersion.to}`,
    });
  }
  if (diff.transport !== null) {
    rows.push({
      key: "transport",
      added: true,
      text: `transport ${diff.transport.from} → ${diff.transport.to}`,
    });
  }
  for (const group of [
    { label: "egress", diff: diff.egressHosts },
    { label: "secret", diff: diff.secretKeys },
    { label: "operation", diff: diff.operations },
    { label: "widget", diff: diff.widgets.names },
  ]) {
    for (const entry of group.diff.added) {
      rows.push({ key: `${group.label}:+:${entry}`, added: true, text: `${group.label} ${entry}` });
    }
    for (const entry of group.diff.removed) {
      rows.push({
        key: `${group.label}:-:${entry}`,
        added: false,
        text: `${group.label} ${entry}`,
      });
    }
  }
  for (const change of diff.operationDescriptions) {
    rows.push({
      key: `operation-description:~:${change.name}`,
      added: true,
      text: `operation ${change.name} description: ${change.from ?? "none"} → ${change.to ?? "none"}`,
    });
  }
  for (const widget of diff.widgets.changed) {
    if (widget.file !== null) {
      rows.push({
        key: `widget-file:~:${widget.name}`,
        added: true,
        text: `widget ${widget.name} file ${widget.file.from} → ${widget.file.to}`,
      });
    }
    for (const group of [
      { label: "subscription", diff: widget.subscriptions },
      { label: "action", diff: widget.actions },
    ]) {
      for (const entry of group.diff.added) {
        rows.push({
          key: `widget-${group.label}:+:${widget.name}:${entry}`,
          added: true,
          text: `widget ${widget.name} ${group.label} ${entry}`,
        });
      }
      for (const entry of group.diff.removed) {
        rows.push({
          key: `widget-${group.label}:-:${widget.name}:${entry}`,
          added: false,
          text: `widget ${widget.name} ${group.label} ${entry}`,
        });
      }
    }
  }
  if (diff.authSchemaChanged) {
    rows.push({ key: "auth-schema", added: true, text: "authSchema changed" });
  }
  // Catch-all for anything the itemized groups miss (today: the pack id;
  // later: any new manifest field) so a real surface move can never render as
  // a bare `schemaVersion N → M`.
  if (diff.surfaceChanged) {
    rows.push({ key: "surface", added: true, text: "manifest surface changed" });
  }
  if (rows.length === 0) {
    return <span className="text-xs text-muted-foreground">No manifest changes.</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => (
        <span
          key={row.key}
          className={
            row.added
              ? "inline-flex w-fit items-center rounded-sm bg-diff-addition/10 px-1.5 py-0.5 font-mono text-2xs text-diff-addition-foreground"
              : "inline-flex w-fit items-center rounded-sm bg-diff-deletion/10 px-1.5 py-0.5 font-mono text-2xs text-diff-deletion-foreground"
          }
        >
          {row.added ? "+" : "-"} {row.text}
        </span>
      ))}
    </div>
  );
}

/**
 * One line of bridge-surface review for a bundled widget: which data
 * subscriptions and actions the sandboxed frame may use, or that it has none.
 */
function widgetBridgeSummary(widget: WatchConnectorPackWidget): string {
  const parts: Array<string> = [];
  if (widget.bridge.subscriptions.length > 0) {
    parts.push(`reads ${widget.bridge.subscriptions.join(", ")}`);
  }
  if (widget.bridge.actions.length > 0) {
    parts.push(`actions ${widget.bridge.actions.join(", ")}`);
  }
  return parts.length === 0 ? "no bridge access" : parts.join(" · ");
}

function ConfirmBody(props: {
  readonly request: WatchConnectorInstallRequest;
  readonly diffBase: WatchConnectorPack | null;
}) {
  const { request } = props;
  const manifest = request.manifest;
  const hashCopyRef = useRef<HTMLButtonElement | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(hashCopyRef),
    onError: (error: Error) => showAnchoredCopyErrorToast(hashCopyRef, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  const OriginIcon = request.origin.kind === "localPath" ? FolderOpenIcon : GlobeIcon;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {request.packId === null ? null : (
          <span className="text-sm font-medium">{request.packId}</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <OriginIcon className="size-3.5 shrink-0" />
          <MiddleTruncate value={watchConnectorOriginLabel(request.origin)} />
          {request.localUrl ? (
            <Badge size="sm" variant="warning">
              local URL
            </Badge>
          ) : null}
        </span>
        {request.contentHash === null ? null : (
          <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
            <span className="shrink-0 font-sans">SHA-256</span>
            <MiddleTruncate value={request.contentHash} />
            <Button
              ref={hashCopyRef}
              variant="ghost"
              size="icon-micro"
              aria-label="Copy content hash"
              onClick={() => copyToClipboard(request.contentHash ?? "")}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </span>
        )}
      </div>
      {manifest === null ? null : (
        <>
          {request.kind === "upgrade" && props.diffBase !== null ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Changes</span>
              <ManifestDiffRows diffBase={props.diffBase} manifest={manifest} />
            </div>
          ) : null}
          <PermissionGroup
            label={manifest.transport === "file" ? "Can read" : "Can reach"}
            entries={manifest.egressHosts}
            icon={manifest.transport === "file" ? FolderOpenIcon : GlobeIcon}
          />
          <PermissionGroup
            label="Can use secrets"
            entries={manifest.secretKeys}
            icon={KeyRoundIcon}
          />
          {manifest.operations.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Operations it exposes
              </span>
              <div className="flex flex-col gap-1.5">
                {manifest.operations.map((operation) => (
                  <div key={operation.name} className="flex flex-col gap-0.5">
                    <span className="w-fit font-mono text-xs">{operation.name}</span>
                    {operation.description === undefined ? null : (
                      <span className="text-xs text-muted-foreground">{operation.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(manifest.widgets ?? []).length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Bundled widgets</span>
              <div className="flex flex-col gap-1.5">
                {(manifest.widgets ?? []).map((widget) => (
                  <div key={widget.name} className="flex flex-col gap-0.5">
                    <span className="w-fit font-mono text-xs">{widget.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {widgetBridgeSummary(widget)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {manifest.secretKeys.length > 0 ? (
            <Alert variant="info">
              <AlertDescription>
                You will add credentials after {request.kind === "install" ? "install" : "upgrade"}.
                They are stored in this environment's secret store, not the pack.
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

export function WatchConnectorInstallConfirmDialog(props: {
  readonly environmentId: EnvironmentId;
  /** The pending request under review; null keeps the dialog closed. */
  readonly request: WatchConnectorInstallRequest | null;
  readonly onClose: () => void;
}) {
  const request = props.request;
  const requestId = request?.id ?? null;
  const isUpgrade = request?.kind === "upgrade";

  const [reviewed, setReviewed] = useState(false);
  const [preparedResult, setPrepared] = useState<WatchConnectorPrepareInstallConfirmResult | null>(
    null,
  );
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const prepareConfirm = useAtomCommand(watchEnvironment.prepareConnectorInstallConfirm, {
    reportFailure: false,
  });
  const confirmInstall = useAtomCommand(watchEnvironment.confirmConnectorInstall, {
    reportFailure: false,
  });
  const confirmUpgrade = useAtomCommand(watchEnvironment.confirmConnectorUpgrade, {
    reportFailure: false,
  });
  const cancelRequest = useAtomCommand(watchEnvironment.cancelConnectorInstallRequest);
  // The grant gates the matching confirm command — installs and upgrades are
  // separately guarded methods, so the atom must follow the request kind.
  const confirmCommand = isUpgrade
    ? watchEnvironment.confirmConnectorUpgrade
    : watchEnvironment.confirmConnectorInstall;
  const canConfirm = useAtomValue(confirmCommand.permissionAtom(props.environmentId));

  // A new request resets all dialog state during render — including the
  // preparing flag, so the auto-prepare below is never double-run.
  const [seenRequestId, setSeenRequestId] = useState(requestId);
  // A prepared result belongs to the request that produced it; a stale one
  // from the previous request must not leak into this render's derivations
  // (the reset below only takes effect on the next render).
  const prepared = seenRequestId === requestId ? preparedResult : null;
  const shownRequest = prepared?.request ?? request;
  // A localUrl request may only be fetched under the caller's acknowledgement;
  // everything else prepares — minting the confirm token — as soon as it
  // opens. Derived from `shownRequest` so the fetched request that prepare
  // returns flips the dialog from the fetch ack to the review ack.
  const needsLocalFetchAck = shownRequest !== null && watchInstallRequestIsUnfetched(shownRequest);
  const needsReviewAck = shownRequest !== null && watchInstallRequestNeedsReviewAck(shownRequest);
  // The auto-prepare below must not re-fire when `needsLocalFetchAck` flips
  // false as `prepared` (or a live request update) lands. Read/written only in
  // effects and handlers; cleared by the requestId-keyed effect below.
  const prepareAttemptedRef = useRef<typeof requestId>(null);

  if (seenRequestId !== requestId) {
    setSeenRequestId(requestId);
    setReviewed(false);
    setPrepared(null);
    setPreparing(requestId !== null && !needsLocalFetchAck);
    setPrepareError(null);
    setConfirming(false);
    setConfirmError(null);
  }

  // The deferred-fetch ack and the post-fetch review ack are two separate
  // acts: when `prepared` lands for a `localUrl` request the checkbox flips
  // meaning, and the checked state must not carry over.
  const [preparedForAck, setPreparedForAck] = useState(prepared);
  if (prepared !== preparedForAck) {
    setPreparedForAck(prepared);
    if (prepared !== null && request?.localUrl === true) {
      setReviewed(false);
    }
  }

  // Effects run in declaration order, so on a request change this reset lands
  // before the auto-prepare below reads the ref — covering the close-then-
  // reopen-same-request case the render-phase reset cannot reach. The effect
  // body deliberately only touches the ref; `requestId` is the trigger.
  useEffect(() => {
    prepareAttemptedRef.current = null;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the body only touches the ref; requestId is the intentional trigger
  }, [requestId]);

  useEffect(() => {
    if (
      requestId === null ||
      needsLocalFetchAck ||
      prepared !== null ||
      prepareAttemptedRef.current === requestId
    ) {
      return;
    }
    prepareAttemptedRef.current = requestId;
    let cancelled = false;
    void prepareConfirm({
      environmentId: props.environmentId,
      input: { requestId },
    }).then((result) => {
      if (cancelled) return;
      setPreparing(false);
      if (AsyncResult.isSuccess(result)) {
        setPrepared(result.value);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setPrepareError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "Could not prepare this request.",
      );
    });
    return () => {
      cancelled = true;
    };
    // prepareConfirm is a stable command runner; the request id is the key.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [requestId, needsLocalFetchAck, prepared, props.environmentId]);

  const runPrepareWithAck = () => {
    if (requestId === null) return;
    prepareAttemptedRef.current = requestId;
    setPreparing(true);
    setPrepareError(null);
    void prepareConfirm({
      environmentId: props.environmentId,
      input: { requestId, allowLocalUrl: true },
    }).then((result) => {
      setPreparing(false);
      if (AsyncResult.isSuccess(result)) {
        setPrepared(result.value);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setPrepareError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "Could not fetch this pack.",
      );
    });
  };

  const handleConfirm = () => {
    if (prepared === null || requestId === null) return;
    const command = isUpgrade ? confirmUpgrade : confirmInstall;
    setConfirming(true);
    setConfirmError(null);
    void command({
      environmentId: props.environmentId,
      input: { requestId, confirmationToken: prepared.confirmationToken },
    }).then((result) => {
      setConfirming(false);
      if (AsyncResult.isSuccess(result)) {
        toastManager.add({
          type: "success",
          title: isUpgrade ? "Connector pack upgraded" : "Connector pack installed",
          timeout: 4000,
        });
        props.onClose();
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setConfirmError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "Confirmation failed.",
      );
    });
  };

  const confirmDisabled =
    prepared === null ||
    confirming ||
    !canConfirm ||
    ((needsReviewAck || needsLocalFetchAck) && !reviewed);

  return (
    <Dialog open={request !== null} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isUpgrade ? "Upgrade connector pack" : "Install connector pack"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {shownRequest === null ? null : (
            <div className="flex flex-col gap-4">
              <ConfirmBody request={shownRequest} diffBase={prepared?.diffBase ?? null} />
              {needsLocalFetchAck && prepared === null ? (
                <Alert variant="warning">
                  <TriangleAlertIcon className="size-4" />
                  <AlertTitle>This URL may point at a local or private address.</AlertTitle>
                  <AlertDescription>
                    Nothing has been fetched yet. Review the link below before continuing.
                  </AlertDescription>
                </Alert>
              ) : null}
              {needsReviewAck || needsLocalFetchAck ? (
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={reviewed}
                    onCheckedChange={(checked) => setReviewed(checked === true)}
                  />
                  <span>
                    {needsLocalFetchAck && prepared === null
                      ? "I reviewed this URL and allow fetching it."
                      : "I reviewed what this pack can reach."}
                  </span>
                </label>
              ) : null}
              {preparing ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : null}
              {prepareError === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{prepareError}</AlertDescription>
                </Alert>
              )}
              {confirmError === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{confirmError}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {requestId === null ? null : (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                void cancelRequest({
                  environmentId: props.environmentId,
                  input: { requestId },
                });
                props.onClose();
              }}
            >
              Decline
            </Button>
          )}
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {needsLocalFetchAck && prepared === null ? (
            <Button disabled={!reviewed || preparing} onClick={runPrepareWithAck}>
              {preparing ? "Fetching…" : "Fetch and review"}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button disabled={confirmDisabled} onClick={handleConfirm}>
                    {confirming ? "Confirming…" : isUpgrade ? "Confirm upgrade" : "Confirm install"}
                  </Button>
                }
              />
              {!canConfirm ? (
                <TooltipPopup>This connection cannot approve connector changes.</TooltipPopup>
              ) : null}
            </Tooltip>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

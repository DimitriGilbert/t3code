import {
  WS_METHODS,
  type EnvironmentId,
  type WatchPageId,
  type WatchPageRevisionConflictError,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentRpcInput, EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentRpcKey,
  squashAtomCommandFailure,
} from "./runtime.ts";
import { createWatchNotificationAtoms } from "./watchNotifications.ts";

/**
 * Whether a failed watch write means the page changed under the client and
 * its view must reload before retrying. A structural `_tag` check rather than
 * a schema check: the squashed cause of a failed RPC is not guaranteed to be
 * a decoded error class instance, only a tagged value.
 */
export function isWatchPageRevisionConflict(
  error: unknown,
): error is WatchPageRevisionConflictError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WatchPageRevisionConflictError"
  );
}

/**
 * Watch-page atoms shared by web, desktop, and mobile. `pagesLive` carries
 * both projections; the client chooses the view — mobile reads `mobileOrder`/
 * `mobileHidden`, desktop the grid placement.
 */
export function createWatchEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const needsReloadFamily = Atom.family((key: string) =>
    Atom.make(false).pipe(Atom.withLabel(`environment-data:watch:needs-reload:${key}`)),
  );

  /**
   * True when a revision-checked write on this page failed with a conflict:
   * the client's view is stale and the prompt is to reload before retrying.
   * Writable — the client clears it once the page shows fresh data.
   */
  const needsReload = (target: { environmentId: EnvironmentId; pageId: WatchPageId }) =>
    needsReloadFamily(
      environmentRpcKey({ environmentId: target.environmentId, input: target.pageId }),
    );

  /**
   * Revision-checked mutation built on `createEnvironmentRpcCommand`: the
   * shared boundary keeps the grant check and the `RpcPermissionGuard`
   * install. The `run` wrapper only adds the conflict flag — a settled
   * failure whose squashed cause is the revision conflict marks the page for
   * reload, the same tagged-value check the caller's toast path applies.
   */
  const revisionCheckedCommand = <TTag extends EnvironmentUnaryRpcTag>(
    label: string,
    tag: TTag,
  ) => {
    const command = createEnvironmentRpcCommand(runtime, { label, tag });
    return {
      ...command,
      run: (
        registry: AtomRegistry.AtomRegistry,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: EnvironmentRpcInput<TTag>;
        },
      ) =>
        command.run(registry, target).then((result) => {
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            if (isWatchPageRevisionConflict(failure)) {
              registry.set(
                needsReload({ environmentId: target.environmentId, pageId: failure.pageId }),
                true,
              );
            }
          }
          return result;
        }),
    };
  };

  return {
    /** All watch pages and widgets; emits on subscribe and after every change. */
    pagesLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:watch:pages",
      tag: WS_METHODS.watchPagesSubscribe,
    }),
    gallery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:watch:gallery",
      tag: WS_METHODS.watchGalleryList,
      staleTimeMs: 60_000,
    }),
    needsReload,
    /** Connector packs, instances, pending requests, and pack-registered widget sources. */
    connectorsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:watch:connectors",
      tag: WS_METHODS.watchConnectorsSubscribeInstances,
    }),
    /**
     * One connector instance's snapshot stream (`WatchConnectorStreamItem`):
     * the data an agent widget's bridge feed delivers into its sandbox.
     */
    connectorStream: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:watch:connector-stream",
      tag: WS_METHODS.watchConnectorSubscribe,
    }),
    /** A published widget source's record; emits on publish, republish, and removal. */
    widgetSourceLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:watch:widget-source",
      tag: WS_METHODS.watchWidgetSourceSubscribe,
    }),
    /** The emitted bundle for a `ready` artifact — what the sandbox document injects. */
    getWidgetSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:widget-source-get",
      tag: WS_METHODS.watchWidgetSourceGet,
    }),
    createPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-create",
      tag: WS_METHODS.watchPagesCreate,
    }),
    renamePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-rename",
      tag: WS_METHODS.watchPagesRename,
    }),
    reorderPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-reorder",
      tag: WS_METHODS.watchPagesReorder,
    }),
    duplicatePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-duplicate",
      tag: WS_METHODS.watchPagesDuplicate,
    }),
    deletePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-delete",
      tag: WS_METHODS.watchPagesDelete,
    }),
    restorePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-restore",
      tag: WS_METHODS.watchPagesRestore,
    }),
    updatePageScope: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-update-scope",
      tag: WS_METHODS.watchPagesUpdateScope,
    }),
    instantiatePageFromGallery: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:page-instantiate-from-gallery",
      tag: WS_METHODS.watchPagesInstantiateFromGallery,
    }),
    addWidget: revisionCheckedCommand(
      "environment-command:watch:widget-add",
      WS_METHODS.watchWidgetsAdd,
    ),
    removeWidget: revisionCheckedCommand(
      "environment-command:watch:widget-remove",
      WS_METHODS.watchWidgetsRemove,
    ),
    configureWidget: revisionCheckedCommand(
      "environment-command:watch:widget-configure",
      WS_METHODS.watchWidgetsConfigure,
    ),
    setLayout: revisionCheckedCommand(
      "environment-command:watch:widget-set-layout",
      WS_METHODS.watchWidgetsSetLayout,
    ),
    setMobileProjection: revisionCheckedCommand(
      "environment-command:watch:widget-set-mobile-projection",
      WS_METHODS.watchWidgetsSetMobileProjection,
    ),
    moveWidgetToPage: revisionCheckedCommand(
      "environment-command:watch:widget-move-to-page",
      WS_METHODS.watchWidgetsMoveToPage,
    ),
    /** Serializes one widget (and its authored agent source) as a t3.watch-widget document. */
    exportWidget: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:widget-export",
      tag: WS_METHODS.watchWidgetsExport,
    }),
    /**
     * A membership write like `addWidget` — the conflict → needsReload flag
     * path applies because import is revision-checked server-side.
     */
    importWidget: revisionCheckedCommand(
      "environment-command:watch:widget-import",
      WS_METHODS.watchWidgetsImport,
    ),
    /**
     * Connector instance config write — also the connector-status widget's
     * "Reconnect": the service bumps `updatedAt`, which restarts the poller
     * runtime and forces a fresh fetch.
     */
    setConnectorInstanceConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-set-instance-config",
      tag: WS_METHODS.watchConnectorsSetInstanceConfig,
    }),
    /**
     * Mints the single-use token bound to the pending request's manifest
     * hash (and, for `localUrl` requests, performs the deferred fetch under
     * the caller-asserted `allowLocalUrl` acknowledgement). Only operate
     * scope is needed to mint — the enforced boundary is
     * `environment:maintain` on the confirm calls plus MCP absence.
     */
    prepareConnectorInstallConfirm: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-prepare-install-confirm",
      tag: WS_METHODS.watchConnectorsPrepareInstallConfirm,
    }),
    /** Human confirm for a pending install — requires the prepare-minted token. */
    confirmConnectorInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-confirm-install",
      tag: WS_METHODS.watchConnectorsConfirmInstall,
    }),
    /** Human confirm for a pending upgrade — same token gate as install. */
    confirmConnectorUpgrade: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-confirm-upgrade",
      tag: WS_METHODS.watchConnectorsConfirmUpgrade,
    }),
    /** Decline a pending install/upgrade request; reversible by requesting again. */
    cancelConnectorInstallRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-cancel-install-request",
      tag: WS_METHODS.watchConnectorsCancelInstallRequest,
    }),
    /** Re-pin an instance to a previously-approved pack version — no fetch, no new code. */
    rollbackConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-rollback",
      tag: WS_METHODS.watchConnectorsRollback,
    }),
    /** Soft-archive a pack and its instances — polling stops, config retained. */
    uninstallConnector: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:connector-uninstall",
      tag: WS_METHODS.watchConnectorsUninstall,
    }),
    /** Notification subscription, history query, and prefs write. */
    notifications: createWatchNotificationAtoms(runtime),
  };
}

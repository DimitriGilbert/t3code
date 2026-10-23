import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isWatchPageRevisionConflict } from "@t3tools/client-runtime/state/watch";
import {
  buildWatchWidgetAddInput,
  buildWatchWidgetAddPackInput,
  buildWatchWidgetConfigureInput,
  buildWatchWidgetDuplicateInput,
  buildWatchWidgetMoveToPageInput,
  buildWatchWidgetSetLayoutInput,
  nextWatchPageName,
  partitionWatchPages,
  watchGalleryInstantiateInput,
  watchPageAmbientProjectId,
  watchPageWidgets,
  watchPlacementFits,
  watchWidgetIsConfigurable,
  WATCH_GRID_EDIT_MIN_WIDTH_PX,
  type WatchFirstPartyWidgetSpec,
} from "@t3tools/client-runtime/state/watch-pages";
import { watchAgentSourceId } from "@t3tools/client-runtime/state/watch-mounts";
import { watchConnectorOriginLabel } from "@t3tools/client-runtime/state/watch-connectors";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  WatchConnectorInstance,
  WatchConnectorInstallRequest,
  WatchGalleryTemplate,
  WatchPackWidgetSource,
  WatchPage,
  WatchPageId,
  WatchWidget,
  WatchWidgetConfig,
  WatchWidgetId,
  WatchWidgetPlacement,
  WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { CheckIcon, LayoutDashboardIcon, PencilIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  useActiveEnvironmentId,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "~/state/entities";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { watchEnvironment } from "~/state/watch";

import { WatchAppSourceDialog } from "./WatchAppSourceDialog";
import { WatchBoard } from "./WatchBoard";
import { WatchConnectorInstallConfirmDialog } from "./WatchConnectorInstallConfirmDialog";
import { WatchGalleryDialog } from "./WatchGalleryDialog";
import { WatchNotificationBell } from "./WatchNotificationBell";
import { WatchPageTabs } from "./WatchPageTabs";
import { WatchThresholdAlertBadge } from "./WatchThresholdAlertBadge";
import { WatchWidgetBody } from "./WatchWidgetBody";
import { WatchWidgetPickerDialog } from "./WatchWidgetPickerDialog";
import { WatchConnectorSecretDialog } from "./widgets/WatchConnectorSecretDialog";
import { useWatchAppMounts } from "./useWatchAppMounts";
import { onWatchUiAction, type WatchUiAction } from "./watchUiBus";

const NEVER_NEEDS_RELOAD_ATOM = Atom.make(false).pipe(
  Atom.withLabel("watch-screen:never-needs-reload"),
);

type WidgetMenuAction =
  | "configure"
  | "view-source"
  | "duplicate"
  | "move-to"
  | `move-to:${number}`
  | "remove";

/**
 * The live side of the board: subscribes to thread shells, server config,
 * and connector state, then hands `WatchWidgetBody` everything it needs per
 * widget. Kept separate so none of the subscriptions attach while Watch is
 * gated off or no environment is selected.
 */
function WatchLiveBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly page: WatchPage;
  readonly widgets: ReadonlyArray<WatchWidget>;
  readonly editing: boolean;
  readonly configuringWidgetId: WatchWidgetId | null;
  /** Absent on the archived page's read-only path — configure stays shut. */
  readonly onConfigureOpen?: (widget: WatchWidget) => void;
  readonly onConfigureClose: () => void;
  readonly onConfigureSubmit: (widget: WatchWidget, config: WatchWidgetConfig) => void;
  readonly onAddWidget?: () => void;
  readonly onCommitLayout?: (widgetId: WatchWidgetId, placement: WatchWidgetPlacement) => void;
  readonly onWidgetMenu?: (widget: WatchWidget, position: { x: number; y: number }) => void;
  /**
   * Agent widgets report their resolved source record here so the screen's
   * context menu can offer "View source".
   */
  readonly onAppSourceRecord?: (
    widgetId: WatchWidgetId,
    record: WatchWidgetSourceRecord | null,
  ) => void;
}) {
  const router = useRouter();
  const settings = useEnvironmentSettings(props.environmentId);
  const serverConfig = useServerConfigs().get(props.environmentId);
  const snoozeSupported = serverConfig?.environment.capabilities?.threadSnooze === true;
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );

  // Connector state feeds connector-source widgets, the connector-status
  // kind, the binding picker inside the configure form, pack widget
  // registrations, and the pending install/upgrade requests a human rules on.
  const needsConnectors =
    props.configuringWidgetId !== null ||
    props.widgets.some(
      (widget) =>
        widget.kind === "connector-status" ||
        widget.config.source?.kind === "connector" ||
        widget.provenance.startsWith("pack:"),
    );
  // Always subscribed: pending install requests must surface even on a board
  // whose widgets are all first-party.
  const connectorsQuery = useEnvironmentQuery(
    watchEnvironment.connectorsLive({ environmentId: props.environmentId, input: {} }),
  );
  const connectorInstances = (connectorsQuery.data?.instances ?? []).filter(
    (instance) => instance.archivedAt === null,
  );
  const connectorPacks = connectorsQuery.data?.packs ?? [];
  const packWidgetSources = connectorsQuery.data?.widgetSources ?? [];
  const pendingInstallRequests = (connectorsQuery.data?.installRequests ?? []).filter(
    (request) => request.status === "pending",
  );
  // Ready once data exists (stale data still counts — it resolved). When
  // nothing consumes connector state the query never ran; connector-free
  // widgets must not wait on a skipped fetch.
  const connectorsReady = !needsConnectors || connectorsQuery.data !== null;
  const connectorsError = needsConnectors ? connectorsQuery.error : null;

  // ≤6 agent frames at once: the registry (one per environment+page) plus the
  // states its change lists produce.
  const appMounts = useWatchAppMounts({
    registryKey: `${props.environmentId}:${props.page.id}`,
    widgets: props.widgets,
  });
  const [reviewRequest, setReviewRequest] = useState<WatchConnectorInstallRequest | null>(null);
  // The dialog reviews the live request — a request cancelled elsewhere or
  // confirmed in-flight drops out of the pending list and closes it.
  const reviewTarget =
    pendingInstallRequests.find((request) => request.id === reviewRequest?.id) ?? null;

  // Same guarded command the connector-status widget rows use.
  const setConnectorInstanceConfig = useOrchestrationCommand(
    watchEnvironment.setConnectorInstanceConfig,
    { reportFailure: false },
  );
  const [secretInstanceId, setSecretInstanceId] = useState<string | null>(null);
  const secretInstance =
    connectorInstances.find((instance) => instance.id === secretInstanceId) ?? null;
  const secretPack =
    secretInstance === null
      ? undefined
      : connectorPacks.find((pack) => pack.packId === secretInstance.packId);

  const openThread = useCallback(
    (ref: ScopedThreadRef) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
    },
    [router],
  );

  const reportConnectorConfigFailure = useCallback(
    (result: AtomCommandResult<unknown, unknown>, title: string) => {
      if (AsyncResult.isSuccess(result)) return;
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description: failure instanceof Error ? failure.message : "The connector request failed.",
      });
    },
    [],
  );

  const reconnectConnector = useCallback(
    (instance: WatchConnectorInstance) => {
      // Resending the stored config bumps updatedAt; the poller restarts and
      // forces a fresh fetch — the wire-level "reconnect".
      void setConnectorInstanceConfig({
        environmentId: props.environmentId,
        input: { instanceId: instance.id, config: instance.config },
      }).then((result) => reportConnectorConfigFailure(result, "Could not reconnect"));
    },
    [props.environmentId, setConnectorInstanceConfig, reportConnectorConfigFailure],
  );

  const renderBody = useCallback(
    (widget: WatchWidget) => (
      <WatchWidgetBody
        environmentId={props.environmentId}
        page={props.page}
        widget={widget}
        projects={projects}
        threads={threads}
        providers={providers}
        snoozeSupported={snoozeSupported}
        timestampFormat={settings.timestampFormat}
        connectorInstances={connectorInstances}
        connectorPacks={connectorPacks}
        packWidgetSources={packWidgetSources}
        appMounts={appMounts}
        {...(props.onAppSourceRecord === undefined
          ? {}
          : { onAppSourceRecord: props.onAppSourceRecord })}
        installRequests={pendingInstallRequests}
        onReviewInstallRequest={setReviewRequest}
        connectorsReady={connectorsReady}
        connectorsError={connectorsError}
        configuring={props.configuringWidgetId === widget.id}
        onConfigureSubmit={props.onConfigureSubmit}
        onConfigureOpen={props.onConfigureOpen}
        onConfigureClose={props.onConfigureClose}
        onReconnectConnector={reconnectConnector}
        onUpdateConnectorSecret={(instance) => setSecretInstanceId(instance.id)}
        onOpenThread={openThread}
      />
    ),
    [
      props.environmentId,
      props.page,
      props.configuringWidgetId,
      props.onConfigureSubmit,
      props.onConfigureOpen,
      props.onConfigureClose,
      props.onAppSourceRecord,
      projects,
      threads,
      providers,
      snoozeSupported,
      settings.timestampFormat,
      connectorInstances,
      connectorPacks,
      packWidgetSources,
      pendingInstallRequests,
      appMounts,
      connectorsReady,
      connectorsError,
      reconnectConnector,
      openThread,
      setSecretInstanceId,
      setReviewRequest,
    ],
  );

  return (
    <>
      {pendingInstallRequests.length === 0 ? null : (
        <Alert variant="info" className="mb-4">
          <AlertTitle>
            {pendingInstallRequests.length === 1
              ? "A connector pack change awaits approval."
              : `${pendingInstallRequests.length} connector pack changes await approval.`}
          </AlertTitle>
          <AlertAction>
            {pendingInstallRequests.length === 1 ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const first = pendingInstallRequests[0];
                  if (first !== undefined) setReviewRequest(first);
                }}
              >
                Review
              </Button>
            ) : (
              // Every pending request must be individually resolvable — with
              // several queued, Review lists them instead of picking one.
              <Menu>
                <MenuTrigger
                  render={<Button size="xs" variant="outline" aria-label="Review requests" />}
                >
                  Review
                </MenuTrigger>
                <MenuPopup align="end">
                  {pendingInstallRequests.map((request) => (
                    <MenuItem key={request.id} onClick={() => setReviewRequest(request)}>
                      {`${request.packId ?? watchConnectorOriginLabel(request.origin)} (${request.kind})`}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            )}
          </AlertAction>
        </Alert>
      )}
      <WatchBoard
        widgets={props.widgets}
        editing={props.editing}
        configuringWidgetId={props.configuringWidgetId}
        {...(props.onAddWidget === undefined ? {} : { onAddWidget: props.onAddWidget })}
        {...(props.onCommitLayout === undefined ? {} : { onCommitLayout: props.onCommitLayout })}
        {...(props.onConfigureOpen === undefined
          ? {}
          : { onConfigureWidget: props.onConfigureOpen })}
        {...(props.onWidgetMenu === undefined ? {} : { onWidgetMenu: props.onWidgetMenu })}
        renderBody={renderBody}
        renderHeaderAlert={(widget) => (
          <WatchThresholdAlertBadge environmentId={props.environmentId} widgetId={widget.id} />
        )}
      />
      <WatchConnectorInstallConfirmDialog
        environmentId={props.environmentId}
        request={reviewTarget}
        onClose={() => setReviewRequest(null)}
      />
      {secretInstance !== null ? (
        <WatchConnectorSecretDialog
          instance={secretInstance}
          secretKeys={secretPack?.manifest.secretKeys ?? []}
          onSubmit={(secrets, clearSecretKeys) => {
            setSecretInstanceId(null);
            void setConnectorInstanceConfig({
              environmentId: props.environmentId,
              input: {
                instanceId: secretInstance.id,
                config: secretInstance.config,
                secrets,
                ...(clearSecretKeys.length === 0 ? {} : { clearSecretKeys: [...clearSecretKeys] }),
              },
            }).then((result) => reportConnectorConfigFailure(result, "Could not update secrets"));
          }}
          onClose={() => setSecretInstanceId(null)}
        />
      ) : null}
    </>
  );
}

function WatchBoardSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      <Skeleton className="col-span-2 h-32 md:col-span-4" />
      <Skeleton className="col-span-2 h-32" />
      <Skeleton className="col-span-2 h-24 md:col-span-3" />
      <Skeleton className="col-span-2 h-24 md:col-span-3" />
    </div>
  );
}

/**
 * Result handler for every watch page/widget write. A revision conflict
 * keeps its dedicated warning — `revisionCheckedCommand` already flagged
 * the page's inline reload banner — while every other failure (layout
 * collision, page error, permission denial, transport) surfaces as an
 * error toast rather than vanishing to the console reporter. Exported for
 * tests.
 */
export function reportWatchWriteResult(result: AtomCommandResult<unknown, unknown>): void {
  if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) return;
  const failure = squashAtomCommandFailure(result);
  if (isWatchPageRevisionConflict(failure)) {
    toastManager.add({
      type: "warning",
      title: "This page changed on another client.",
      description: "Reload to pick up the latest layout, then retry.",
      timeout: 5000,
    });
    return;
  }
  toastManager.add({
    type: "error",
    title: "The watch change did not apply.",
    description:
      failure instanceof Error && failure.message !== ""
        ? failure.message
        : "The write was rejected.",
  });
}

/**
 * Configure-save plumbing kept separate so tests can drive it: the outcome
 * is reported and the form closes only on success — a conflict or failure
 * keeps the draft mounted so the retry the toast suggests has something to
 * send. Exported for tests.
 */
export function settleWatchWidgetConfigure(
  write: Promise<AtomCommandResult<unknown, unknown>>,
  onClose: () => void,
): void {
  void write.then((result) => {
    reportWatchWriteResult(result);
    if (AsyncResult.isSuccess(result)) onClose();
  });
}

export function WatchScreen() {
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId: EnvironmentId | null = activeEnvironmentId ?? primaryEnvironmentId;
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const watchSupported = environment?.serverConfig?.watchScreen === true;

  const pagesQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : watchEnvironment.pagesLive({ environmentId, input: { includeArchived: true } }),
  );
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pagesMenuOpen, setPagesMenuOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<WatchPageId | null>(null);
  // Edit mode is per page; switching pages or going below the edit width
  // pauses it — it resumes when the page is viewed again at editing width.
  const [editingPageId, setEditingPageId] = useState<WatchPageId | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<WatchPageId | null>(null);
  const [configuringWidgetId, setConfiguringWidgetId] = useState<WatchWidgetId | null>(null);
  // Resolved agent-widget source records, keyed by widget id — the context
  // menu reads it imperatively, so a ref keeps it out of render churn.
  const appSourceRecordsRef = useRef(new Map<WatchWidgetId, WatchWidgetSourceRecord>());
  const [viewSourceRecord, setViewSourceRecord] = useState<WatchWidgetSourceRecord | null>(null);
  const handleAppSourceRecord = useCallback(
    (widgetId: WatchWidgetId, record: WatchWidgetSourceRecord | null) => {
      if (record === null) {
        appSourceRecordsRef.current.delete(widgetId);
      } else {
        appSourceRecordsRef.current.set(widgetId, record);
      }
    },
    [],
  );
  const canEditLayout = useMediaQuery({ min: WATCH_GRID_EDIT_MIN_WIDTH_PX });

  const { active, archived } = partitionWatchPages(pagesQuery.data?.pages ?? []);
  const allPages = [...active, ...archived];
  const selectedPage =
    active.find((page) => page.id === selectedPageId) ??
    archived.find((page) => page.id === selectedPageId) ??
    active[0] ??
    null;
  const selectedWidgets =
    selectedPage === null ? [] : watchPageWidgets(pagesQuery.data?.widgets ?? [], selectedPage.id);
  const needsReload = useAtomValue(
    environmentId !== null && selectedPage !== null
      ? watchEnvironment.needsReload({ environmentId, pageId: selectedPage.id })
      : NEVER_NEEDS_RELOAD_ATOM,
  );
  const editing =
    canEditLayout &&
    editingPageId !== null &&
    selectedPage !== null &&
    editingPageId === selectedPage.id &&
    selectedPage.archivedAt === null;

  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );

  // The picker lists pack-registered widget sources; subscribe only while it
  // is open — the board's own subscription already covers mounted widgets.
  const pickerConnectorsQuery = useEnvironmentQuery(
    pickerOpen && environmentId !== null
      ? watchEnvironment.connectorsLive({ environmentId, input: {} })
      : null,
  );
  const pickerPackSources = pickerConnectorsQuery.data?.widgetSources ?? [];
  const pickerInstances = pickerConnectorsQuery.data?.instances ?? [];

  // The empty state previews the gallery, so it is fetched ahead of the dialog.
  const galleryQuery = useEnvironmentQuery(
    environmentId !== null && (galleryOpen || (pagesQuery.isSuccess && active.length === 0))
      ? watchEnvironment.gallery({ environmentId, input: {} })
      : null,
  );
  const templates = galleryQuery.data?.templates ?? [];

  const createPage = useAtomCommand(watchEnvironment.createPage);
  const renamePage = useAtomCommand(watchEnvironment.renamePage);
  const reorderPage = useAtomCommand(watchEnvironment.reorderPage);
  const duplicatePage = useAtomCommand(watchEnvironment.duplicatePage);
  const deletePage = useAtomCommand(watchEnvironment.deletePage);
  const restorePage = useAtomCommand(watchEnvironment.restorePage);
  const updatePageScope = useAtomCommand(watchEnvironment.updatePageScope);
  const instantiateFromGallery = useAtomCommand(watchEnvironment.instantiatePageFromGallery);
  const addWidget = useAtomCommand(watchEnvironment.addWidget);
  const removeWidget = useAtomCommand(watchEnvironment.removeWidget);
  const configureWidget = useAtomCommand(watchEnvironment.configureWidget);
  const setLayout = useAtomCommand(watchEnvironment.setLayout);
  const moveWidgetToPage = useAtomCommand(watchEnvironment.moveWidgetToPage);

  const handleCreatePage = useCallback(
    (projectId?: ProjectId) => {
      if (environmentId === null) return;
      void createPage({
        environmentId,
        input: {
          name: nextWatchPageName(allPages),
          ...(projectId === undefined
            ? { scope: "global" as const }
            : { scope: "project" as const, projectId }),
        },
      }).then((result) => {
        reportWatchWriteResult(result);
        if (!AsyncResult.isSuccess(result)) return;
        setSelectedPageId(result.value.page.id);
        setRenamingPageId(result.value.page.id);
        setEditingPageId(result.value.page.id);
      });
    },
    [allPages, createPage, environmentId],
  );

  const handleRenameCommit = useCallback(
    (pageId: WatchPageId, name: string) => {
      setRenamingPageId(null);
      if (environmentId === null) return;
      void renamePage({ environmentId, input: { pageId, name } }).then(reportWatchWriteResult);
    },
    [environmentId, renamePage],
  );

  const handleDeletePage = useCallback(
    (pageId: WatchPageId) => {
      const api = readLocalApi();
      const page = allPages.find((entry) => entry.id === pageId);
      if (api === undefined || page === undefined || environmentId === null) return;
      void api.dialogs
        .confirm(`Delete "${page.name}"?\nThis removes the page and its widgets.`, {
          variant: "destructive",
        })
        .then((confirmed) => {
          if (!confirmed) return;
          void deletePage({ environmentId, input: { pageId } }).then(reportWatchWriteResult);
        });
    },
    [allPages, deletePage, environmentId],
  );

  const handleInstantiate = useCallback(
    (template: WatchGalleryTemplate) => {
      if (environmentId === null) return;
      setGalleryOpen(false);
      void instantiateFromGallery({
        environmentId,
        input: watchGalleryInstantiateInput(template),
      }).then((result) => {
        reportWatchWriteResult(result);
        if (!AsyncResult.isSuccess(result)) return;
        setSelectedPageId(result.value.page.id);
      });
    },
    [environmentId, instantiateFromGallery],
  );

  const handlePickWidget = useCallback(
    (spec: WatchFirstPartyWidgetSpec) => {
      setPickerOpen(false);
      if (environmentId === null || selectedPage === null) return;
      void addWidget({
        environmentId,
        input: buildWatchWidgetAddInput(selectedPage, selectedWidgets, spec.kind),
      }).then(reportWatchWriteResult);
    },
    [addWidget, environmentId, selectedPage, selectedWidgets],
  );

  const handlePickPackSource = useCallback(
    (source: WatchPackWidgetSource) => {
      setPickerOpen(false);
      if (environmentId === null || selectedPage === null) return;
      // One live instance of the pack binds it directly; zero or several
      // leaves the binding for the widget's configure form.
      const instances = pickerInstances.filter(
        (instance) => instance.packId === source.packId && instance.archivedAt === null,
      );
      const instanceId = instances.length === 1 ? instances[0]?.id : undefined;
      void addWidget({
        environmentId,
        input: buildWatchWidgetAddPackInput(
          selectedPage,
          selectedWidgets,
          source,
          instanceId === undefined ? {} : { instanceId },
        ),
      }).then(reportWatchWriteResult);
    },
    [addWidget, environmentId, pickerInstances, selectedPage, selectedWidgets],
  );

  // One committed placement per gesture — the board only calls this for
  // non-colliding candidates, and the same check runs here so a stale read
  // can never send an overlapping write.
  const handleCommitLayout = useCallback(
    (widgetId: WatchWidgetId, placement: WatchWidgetPlacement) => {
      if (environmentId === null || selectedPage === null || !editing) return;
      const others = selectedWidgets
        .filter((widget) => widget.id !== widgetId)
        .map((widget) => widget.placement);
      if (!watchPlacementFits(placement, others)) return;
      void setLayout({
        environmentId,
        input: buildWatchWidgetSetLayoutInput(selectedPage, widgetId, placement),
      }).then(reportWatchWriteResult);
    },
    [editing, environmentId, selectedPage, selectedWidgets, setLayout],
  );

  const handleConfigureSave = useCallback(
    (widget: WatchWidget, config: WatchWidgetConfig) => {
      if (environmentId === null) return;
      settleWatchWidgetConfigure(
        configureWidget({
          environmentId,
          input: buildWatchWidgetConfigureInput(widget, config),
        }),
        () => setConfiguringWidgetId(null),
      );
    },
    [configureWidget, environmentId],
  );

  const handleWidgetMenu = useCallback(
    async (widget: WatchWidget, position: { x: number; y: number }) => {
      const api = readLocalApi();
      const page = selectedPage;
      if (api === undefined || page === null || environmentId === null) return;
      const destinations = active.filter((entry) => entry.id !== page.id);
      // Configure leads the menu only when the generated form has something
      // to edit — a zero-field widget offers nothing to configure.
      const configureItems: ReadonlyArray<{ id: WidgetMenuAction; label: string; icon: string }> =
        watchWidgetIsConfigurable(widget)
          ? [{ id: "configure", label: "Configure", icon: "settings" }]
          : [];
      // Agent/pack kinds get "View source" once the record resolves — the
      // published TSX is reviewable host-side, never inside the frame.
      const sourceItems: ReadonlyArray<{ id: WidgetMenuAction; label: string }> =
        watchAgentSourceId(widget.kind) !== undefined && appSourceRecordsRef.current.has(widget.id)
          ? [{ id: "view-source", label: "View source" }]
          : [];
      const action = await api.contextMenu.show<WidgetMenuAction>(
        [
          ...configureItems,
          ...sourceItems,
          { id: "duplicate", label: "Duplicate", icon: "copy" },
          {
            id: "move-to",
            label: "Move to page",
            icon: "folder-tree",
            disabled: destinations.length === 0,
            children: destinations.map((destination, index) => ({
              id: `move-to:${index}` as const,
              label: destination.name,
            })),
          },
          {
            id: "remove",
            label: "Remove",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
          },
        ],
        position,
      );
      if (action === null) return;
      if (action === "configure") {
        setConfiguringWidgetId(widget.id);
        return;
      }
      if (action === "view-source") {
        const record = appSourceRecordsRef.current.get(widget.id);
        if (record !== undefined) setViewSourceRecord(record);
        return;
      }
      if (action === "duplicate") {
        void addWidget({
          environmentId,
          input: buildWatchWidgetDuplicateInput(page, selectedWidgets, widget),
        }).then(reportWatchWriteResult);
        return;
      }
      if (action === "remove") {
        void removeWidget({
          environmentId,
          input: { pageId: page.id, widgetId: widget.id, expectedRevision: page.revision },
        }).then(reportWatchWriteResult);
        return;
      }
      if (action.startsWith("move-to:")) {
        const destination = destinations[Number.parseInt(action.slice("move-to:".length), 10)];
        if (destination === undefined) return;
        const destinationWidgets = (pagesQuery.data?.widgets ?? []).filter(
          (entry) => entry.pageId === destination.id,
        );
        void moveWidgetToPage({
          environmentId,
          input: buildWatchWidgetMoveToPageInput(widget, page, destination, destinationWidgets),
        }).then(reportWatchWriteResult);
      }
    },
    [
      active,
      addWidget,
      environmentId,
      moveWidgetToPage,
      pagesQuery.data?.widgets,
      removeWidget,
      selectedPage,
      selectedWidgets,
    ],
  );

  const requestEditToggle = useCallback(
    (pageId?: WatchPageId) => {
      if (!canEditLayout) {
        toastManager.add({
          type: "warning",
          title: "Layout editing needs a wider window.",
          description: "Resize to at least 1200px to edit the board.",
          timeout: 3000,
        });
        return;
      }
      const target =
        pageId === undefined ? selectedPage : (allPages.find((page) => page.id === pageId) ?? null);
      if (target === null || target.archivedAt !== null) return;
      // A menu action names its page, so select it before toggling — the edit
      // flag would otherwise land on whatever page happened to be selected.
      setSelectedPageId(target.id);
      setEditingPageId((current) => (current === target.id ? null : target.id));
      // An open configure form belongs to the edit session that opened it.
      setConfiguringWidgetId(null);
    },
    [allPages, canEditLayout, selectedPage],
  );

  // Below the edit width `editing` derives false while the flag stays set, so
  // widening the window resumes the page's edit session.
  const handleUiAction = useCallback(
    (action: WatchUiAction) => {
      switch (action) {
        case "new-page":
          handleCreatePage();
          return;
        case "toggle-edit":
          requestEditToggle();
          return;
        case "add-widget":
          if (selectedPage !== null && selectedPage.archivedAt === null) setPickerOpen(true);
          return;
        case "switch-page":
          setPagesMenuOpen(true);
          return;
        case "open-gallery":
          setGalleryOpen(true);
          return;
      }
    },
    [handleCreatePage, requestEditToggle, selectedPage],
  );

  // Only a supported screen consumes queued intents — registering while
  // gated off would flush (and discard) actions meant for a real mount.
  useEffect(() => {
    if (!watchSupported) return;
    return onWatchUiAction(handleUiAction);
  }, [handleUiAction, watchSupported]);

  useEscapeToGoBack(
    editing
      ? () => {
          setEditingPageId(null);
          setConfiguringWidgetId(null);
        }
      : undefined,
  );

  if (!watchSupported) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron}>
            <span className="text-sm font-medium">Watch</span>
          </WorkspacePageHeader>
          <Empty size="hero" className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutDashboardIcon />
              </EmptyMedia>
              <EmptyTitle>Watch is not available</EmptyTitle>
              <EmptyDescription>
                This environment does not support the watch screen.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <WatchPageTabs
              pages={active}
              archivedPages={archived}
              selectedPageId={selectedPage?.id ?? null}
              viewedProjectId={
                selectedPage === null ? null : watchPageAmbientProjectId(selectedPage)
              }
              editing={editing}
              renamingPageId={renamingPageId}
              projects={projects}
              pagesMenuOpen={pagesMenuOpen}
              onPagesMenuOpenChange={setPagesMenuOpen}
              onSelectPage={(pageId) => {
                setSelectedPageId(pageId);
                setConfiguringWidgetId(null);
              }}
              onCreatePage={handleCreatePage}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={() => setRenamingPageId(null)}
              onDuplicatePage={(pageId) => {
                if (environmentId === null) return;
                void duplicatePage({ environmentId, input: { pageId } }).then((result) => {
                  reportWatchWriteResult(result);
                  if (AsyncResult.isSuccess(result)) setSelectedPageId(result.value.page.id);
                });
              }}
              onDeletePage={handleDeletePage}
              onRestorePage={(pageId) => {
                if (environmentId === null) return;
                void restorePage({ environmentId, input: { pageId } }).then((result) => {
                  reportWatchWriteResult(result);
                  if (AsyncResult.isSuccess(result)) setSelectedPageId(result.value.page.id);
                });
              }}
              onUpdatePageScope={(pageId, scope, projectId) => {
                if (environmentId === null) return;
                void updatePageScope({
                  environmentId,
                  input: {
                    pageId,
                    scope,
                    ...(projectId === undefined ? {} : { projectId }),
                  },
                }).then(reportWatchWriteResult);
              }}
              onReorderPage={(pageId, beforePageId) => {
                if (environmentId === null) return;
                void reorderPage({ environmentId, input: { pageId, beforePageId } }).then(
                  reportWatchWriteResult,
                );
              }}
              onStartRename={(pageId) => setRenamingPageId(pageId)}
              onToggleEdit={requestEditToggle}
              onOpenGallery={() => setGalleryOpen(true)}
            />
            {canEditLayout && selectedPage !== null && selectedPage.archivedAt === null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant={editing ? "secondary" : "ghost"}
                      aria-label={editing ? "Done editing" : "Edit page"}
                      onClick={() => requestEditToggle()}
                    >
                      {editing ? <CheckIcon /> : <PencilIcon />}
                      {editing ? "Done" : "Edit"}
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">
                  <span className="inline-flex items-center gap-1.5">
                    {editing ? "Done editing" : "Edit page"} <Kbd>e</Kbd>
                  </span>
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {environmentId === null ? null : <WatchNotificationBell environmentId={environmentId} />}
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-h-full flex-col px-5 pt-4 pb-12 sm:px-6">
            {needsReload && selectedPage !== null && environmentId !== null ? (
              <Alert variant="warning" className="mb-4">
                <AlertTitle>This page changed on another client.</AlertTitle>
                <AlertDescription>Reload to pick up the latest layout.</AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      appAtomRegistry.set(
                        watchEnvironment.needsReload({
                          environmentId,
                          pageId: selectedPage.id,
                        }),
                        false,
                      );
                    }}
                  >
                    Dismiss
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            {pagesQuery.isPending && pagesQuery.data === null ? (
              <WatchBoardSkeleton />
            ) : pagesQuery.error !== null && pagesQuery.data === null ? (
              <Empty size="compact" className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>Could not load pages</EmptyTitle>
                  <EmptyDescription>{pagesQuery.error}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={pagesQuery.refresh}>
                    Try again
                  </Button>
                </EmptyContent>
              </Empty>
            ) : active.length === 0 && archived.length === 0 ? (
              <Empty size="hero" className="flex-1">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <LayoutDashboardIcon />
                  </EmptyMedia>
                  <EmptyTitle>Build a watch screen</EmptyTitle>
                  <EmptyDescription>
                    Pages of widgets that track threads, connectors, and services.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <div className="flex items-center justify-center gap-2">
                    <Button onClick={() => setGalleryOpen(true)}>Start from a template</Button>
                    <Button variant="ghost" onClick={() => handleCreatePage()}>
                      Blank page
                    </Button>
                  </div>
                  {templates.length > 0 ? (
                    <DiscoveryList>
                      {templates.slice(0, 3).map((template) => (
                        <DiscoveryListRow
                          key={template.id}
                          icon={
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                              <LayoutDashboardIcon className="size-4" />
                            </span>
                          }
                          title={template.name}
                          description={template.description ?? "A starter watch page."}
                          onClick={() => handleInstantiate(template)}
                        />
                      ))}
                    </DiscoveryList>
                  ) : null}
                </EmptyContent>
              </Empty>
            ) : selectedPage !== null && selectedPage.archivedAt !== null ? (
              <div className="flex flex-1 flex-col gap-4">
                <Alert variant="warning">
                  <AlertTitle>This page is archived.</AlertTitle>
                  <AlertDescription>
                    Its project was deleted. The widgets below are read-only.
                  </AlertDescription>
                  <AlertAction>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => handleDeletePage(selectedPage.id)}
                    >
                      Delete page
                    </Button>
                  </AlertAction>
                </Alert>
                {environmentId === null ? (
                  <WatchBoard widgets={selectedWidgets} editing={false} />
                ) : (
                  <WatchLiveBoard
                    environmentId={environmentId}
                    page={selectedPage}
                    widgets={selectedWidgets}
                    editing={false}
                    configuringWidgetId={null}
                    onConfigureClose={() => setConfiguringWidgetId(null)}
                    onConfigureSubmit={handleConfigureSave}
                  />
                )}
              </div>
            ) : selectedPage === null ? null : selectedWidgets.length === 0 ? (
              <Empty size="default" className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>This page is empty</EmptyTitle>
                  <EmptyDescription>Add a widget to start tracking work.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    Add a widget
                  </Button>
                  {editing ? (
                    <p className="text-xs text-muted-foreground">
                      Drag to arrange once widgets exist.
                    </p>
                  ) : null}
                </EmptyContent>
              </Empty>
            ) : environmentId === null ? null : (
              <WatchLiveBoard
                environmentId={environmentId}
                page={selectedPage}
                widgets={selectedWidgets}
                editing={editing}
                configuringWidgetId={configuringWidgetId}
                onConfigureOpen={(widget) => setConfiguringWidgetId(widget.id)}
                onConfigureClose={() => setConfiguringWidgetId(null)}
                onConfigureSubmit={handleConfigureSave}
                onAddWidget={() => setPickerOpen(true)}
                onCommitLayout={handleCommitLayout}
                onWidgetMenu={(widget, position) => void handleWidgetMenu(widget, position)}
                onAppSourceRecord={handleAppSourceRecord}
              />
            )}
          </div>
        </ScrollArea>

        {viewSourceRecord === null ? null : (
          <WatchAppSourceDialog
            record={viewSourceRecord}
            open
            onOpenChange={(open) => {
              if (!open) setViewSourceRecord(null);
            }}
          />
        )}
        <WatchGalleryDialog
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
          templates={templates}
          onInstantiate={handleInstantiate}
        />
        <WatchWidgetPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={handlePickWidget}
          packSources={pickerPackSources}
          onPickPackSource={handlePickPackSource}
        />
      </div>
    </SidebarInset>
  );
}

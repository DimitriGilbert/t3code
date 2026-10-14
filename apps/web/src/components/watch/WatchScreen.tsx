import { useAtomValue } from "@effect/atom-react";
import {
  buildWatchWidgetAddInput,
  nextWatchPageName,
  partitionWatchPages,
  watchGalleryInstantiateInput,
  watchPageAmbientProjectId,
  watchPageWidgets,
  WATCH_GRID_EDIT_MIN_WIDTH_PX,
  type WatchFirstPartyWidgetSpec,
} from "@t3tools/client-runtime/state/watch-pages";
import type {
  EnvironmentId,
  ProjectId,
  WatchGalleryTemplate,
  WatchPageId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { CheckIcon, LayoutDashboardIcon, PencilIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import { useActiveEnvironmentId, useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { watchEnvironment } from "~/state/watch";

import { WatchBoard } from "./WatchBoard";
import { WatchGalleryDialog } from "./WatchGalleryDialog";
import { WatchPageTabs } from "./WatchPageTabs";
import { WatchWidgetPickerDialog } from "./WatchWidgetPickerDialog";
import { onWatchUiAction, type WatchUiAction } from "./watchUiBus";

const NEVER_NEEDS_RELOAD_ATOM = Atom.make(false).pipe(
  Atom.withLabel("watch-screen:never-needs-reload"),
);

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
      void renamePage({ environmentId, input: { pageId, name } });
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
          void deletePage({ environmentId, input: { pageId } });
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
      });
    },
    [addWidget, environmentId, selectedPage, selectedWidgets],
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

  useEffect(() => onWatchUiAction(handleUiAction), [handleUiAction]);

  useEscapeToGoBack(editing ? () => setEditingPageId(null) : undefined);

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
              onSelectPage={(pageId) => setSelectedPageId(pageId)}
              onCreatePage={handleCreatePage}
              onRenameCommit={handleRenameCommit}
              onRenameCancel={() => setRenamingPageId(null)}
              onDuplicatePage={(pageId) => {
                if (environmentId === null) return;
                void duplicatePage({ environmentId, input: { pageId } }).then((result) => {
                  if (AsyncResult.isSuccess(result)) setSelectedPageId(result.value.page.id);
                });
              }}
              onDeletePage={handleDeletePage}
              onRestorePage={(pageId) => {
                if (environmentId === null) return;
                void restorePage({ environmentId, input: { pageId } }).then((result) => {
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
                });
              }}
              onReorderPage={(pageId, beforePageId) => {
                if (environmentId === null) return;
                void reorderPage({ environmentId, input: { pageId, beforePageId } });
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
                    Reload
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
                <WatchBoard widgets={selectedWidgets} editing={false} />
              </div>
            ) : selectedPage === null ? null : selectedWidgets.length === 0 ? (
              <Empty size="default" className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>This page is empty</EmptyTitle>
                  <EmptyDescription>
                    {editing
                      ? "Add a widget, then drag to arrange."
                      : "Add a widget to start tracking work."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    Add a widget
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <WatchBoard
                widgets={selectedWidgets}
                editing={editing}
                onAddWidget={() => setPickerOpen(true)}
              />
            )}
          </div>
        </ScrollArea>

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
        />
      </div>
    </SidebarInset>
  );
}

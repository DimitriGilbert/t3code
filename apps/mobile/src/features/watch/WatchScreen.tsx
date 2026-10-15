import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isWatchPageRevisionConflict } from "@t3tools/client-runtime/state/watch";
import {
  buildWatchWidgetSetMobileProjectionInput,
  partitionWatchPages,
  watchPageMobileSequence,
  watchPageMobileWidgets,
  watchPageWidgets,
  watchWidgetDisplayTitle,
  type WatchMobileProjectionEdit,
} from "@t3tools/client-runtime/state/watch-pages";
import { watchAgentSourceId } from "@t3tools/client-runtime/state/watch-mounts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  ScopedThreadRef,
  ServerConfig,
  WatchPage,
  WatchPageId,
  WatchWidget,
  WatchWidgetId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, View } from "react-native";
import type { MenuAction } from "@react-native-menu/menu";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import type {
  ScreenHeaderAction,
  ScreenHeaderMenu,
  ScreenHeaderMenuItem,
} from "../../components/ScreenHeader.types";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  useEnvironmentServerConfig,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { watchEnvironment } from "../../state/watch";

import { useWatchAppMounts } from "./useWatchAppMounts";
import { WatchWidgetBody } from "./WatchWidgetBody";
import { WatchWidgetSection } from "./WatchWidgetSection";
import {
  resolveWatchEntryEnvironmentId,
  watchAgentWidgetsMobileSupported,
  watchMobileVisibleWidgets,
  watchScreenSupported,
} from "./watchMobile";

/**
 * The mobile watch screen: a read-only follower of the desktop-composed
 * board. Pages and widgets stream through `pagesLive`; the stack renders
 * `watchPageMobileWidgets` (canonical order → `mobileHidden` filtered →
 * `mobileOrder`), and the only writes mobile makes are reorder/hide through
 * `setMobileProjection`, guarded by `mobileRevision`. Desktop placement is
 * never written; its only read is `mobileWidgetHeight`, which sizes a
 * widget's row from `placement.h`.
 */

const NEVER_NEEDS_RELOAD_ATOM = Atom.make(false).pipe(
  Atom.withLabel("watch-screen:never-needs-reload"),
);

const isEnvironmentId = Schema.is(EnvironmentId);

/**
 * The conflict path for a failed mobile-projection write: `needsReload` is
 * already flipped by the revision-checked command, and web additionally posts
 * a toast — the mobile twin is this alert plus the in-screen banner.
 */
function reportWatchWriteConflict(result: AtomCommandResult<unknown, unknown>): void {
  if (!AsyncResult.isFailure(result)) return;
  if (!isWatchPageRevisionConflict(squashAtomCommandFailure(result))) return;
  Alert.alert(
    "Page changed",
    "This watch page changed on another client. Reload to pick up the latest layout.",
  );
}

/**
 * The live column: threads/projects/connectors subscriptions plus the mount
 * registry live here so nothing attaches while the screen is gated off or
 * there is no page.
 */
function WatchPageColumn(props: {
  readonly environmentId: EnvironmentId;
  readonly page: WatchPage;
  readonly widgets: ReadonlyArray<WatchWidget>;
  readonly serverConfig: ServerConfig;
  readonly editing: boolean;
  readonly now: string;
  readonly onProjectionEdit: (edit: WatchMobileProjectionEdit) => void;
}) {
  const { widgets, page } = props;
  const navigation = useNavigation();
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );

  const agentWidgetsEnabled = watchAgentWidgetsMobileSupported(props.serverConfig);
  const sequence = useMemo(() => watchPageMobileSequence(widgets, page.id), [widgets, page.id]);
  const visibleWidgets = useMemo(
    () => watchMobileVisibleWidgets(watchPageMobileWidgets(widgets, page.id), agentWidgetsEnabled),
    [widgets, page.id, agentWidgetsEnabled],
  );
  // Hidden rows are listed only in edit mode; capability-hidden agent widgets
  // stay out of both views entirely.
  const hiddenWidgets = props.editing
    ? sequence.filter(
        (widget) =>
          widget.mobileHidden &&
          (agentWidgetsEnabled || watchAgentSourceId(widget.kind) === undefined),
      )
    : [];

  // Move affordances follow the rendered stack exactly: rows that render
  // nothing (`mobileHidden` and capability-hidden agent widgets) are never
  // move targets, matching the projection builder.
  const moveState = useMemo(() => {
    const map = new Map<WatchWidgetId, { up: boolean; down: boolean }>();
    visibleWidgets.forEach((widget, index) =>
      map.set(widget.id, { up: index > 0, down: index < visibleWidgets.length - 1 }),
    );
    return map;
  }, [visibleWidgets]);

  // Only rendered rows mount a body, so only they can need connector data.
  const needsConnectors = visibleWidgets.some(
    (widget) =>
      widget.kind === "connector-status" ||
      widget.config.source?.kind === "connector" ||
      widget.provenance.startsWith("pack:"),
  );
  const connectorsQuery = useEnvironmentQuery(
    needsConnectors
      ? watchEnvironment.connectorsLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const connectorInstances = (connectorsQuery.data?.instances ?? []).filter(
    (instance) => instance.archivedAt === null,
  );
  const packWidgetSources = connectorsQuery.data?.widgetSources ?? [];
  const pendingInstallRequests = (connectorsQuery.data?.installRequests ?? []).filter(
    (request) => request.status === "pending",
  );
  const connectorsReady = !needsConnectors || connectorsQuery.data !== null;
  const connectorsError = needsConnectors ? connectorsQuery.error : null;

  const appMounts = useWatchAppMounts({
    registryKey: `${props.environmentId}:${page.id}`,
    widgets,
  });

  const openThread = useCallback(
    (ref: ScopedThreadRef) => {
      navigation.navigate("Thread", {
        environmentId: ref.environmentId,
        threadId: ref.threadId,
      });
    },
    [navigation],
  );

  const openNewTask = useCallback(
    (projectId: ProjectId | null) => {
      if (projectId !== null) {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(props.environmentId),
            projectId: String(projectId),
          },
        });
        return;
      }
      navigation.navigate("NewTaskSheet", { screen: "NewTask" });
    },
    [navigation, props.environmentId],
  );

  const openReview = useCallback(
    (ref: ScopedThreadRef) => {
      navigation.navigate("ThreadReview", {
        environmentId: ref.environmentId,
        threadId: ref.threadId,
      });
    },
    [navigation],
  );

  const openScheduledTasks = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsScheduledTasks" },
    });
  }, [navigation]);

  return (
    <View className="gap-4">
      {visibleWidgets.map((widget) => {
        const move = moveState.get(widget.id) ?? { up: false, down: false };
        return (
          <WatchWidgetSection
            key={widget.id}
            widget={widget}
            editing={props.editing}
            canMoveUp={move.up}
            canMoveDown={move.down}
            onMove={(direction) =>
              props.onProjectionEdit({ type: "move", widgetId: widget.id, direction })
            }
            onHide={() =>
              props.onProjectionEdit({ type: "setHidden", widgetId: widget.id, hidden: true })
            }
          >
            <WatchWidgetBody
              environmentId={props.environmentId}
              page={page}
              widget={widget}
              projects={projects}
              threads={threads}
              now={props.now}
              connectorInstances={connectorInstances}
              packWidgetSources={packWidgetSources}
              installRequests={pendingInstallRequests}
              appMounts={appMounts}
              connectorsReady={connectorsReady}
              connectorsError={connectorsError}
              onOpenThread={openThread}
              onOpenReview={openReview}
              onOpenScheduledTasks={openScheduledTasks}
              onNewTask={openNewTask}
            />
          </WatchWidgetSection>
        );
      })}
      {props.editing && hiddenWidgets.length > 0 ? (
        <View className="gap-1.5">
          <Text className="px-1 text-2xs font-t3-medium uppercase tracking-wide text-foreground-muted">
            Hidden on mobile
          </Text>
          {hiddenWidgets.map((widget) => (
            <View
              key={widget.id}
              className="flex-row items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 opacity-70"
            >
              <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
                {watchWidgetDisplayTitle(widget)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show ${watchWidgetDisplayTitle(widget)} on mobile`}
                onPress={() =>
                  props.onProjectionEdit({
                    type: "setHidden",
                    widgetId: widget.id,
                    hidden: false,
                  })
                }
                className="size-8 items-center justify-center rounded-full active:bg-row-hover"
              >
                <SymbolView name="eye" size={15} tintColorClassName="accent-foreground" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

type WatchRouteScreenProps = StaticScreenProps<{
  readonly environmentId?: string | string[];
}>;

export function WatchRouteScreen({ route }: WatchRouteScreenProps) {
  const navigation = useNavigation();
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useServerConfigs();
  const requestedEnvironmentId = useMemo(() => {
    const raw = route.params?.environmentId;
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    return candidate !== undefined && isEnvironmentId(candidate) ? candidate : null;
  }, [route.params?.environmentId]);
  const environmentId = useMemo(
    () =>
      requestedEnvironmentId !== null &&
      environments.some((entry) => entry.environmentId === requestedEnvironmentId)
        ? requestedEnvironmentId
        : resolveWatchEntryEnvironmentId({ environments, serverConfigs }),
    [environments, requestedEnvironmentId, serverConfigs],
  );
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const supported =
    environmentId !== null && serverConfig !== null && watchScreenSupported(serverConfig);

  if (!supported || environmentId === null || serverConfig === null) {
    return (
      <View className="flex-1 bg-screen">
        {Platform.OS === "android" ? (
          <AndroidScreenHeader title="Watch" onBack={() => navigation.goBack()} />
        ) : (
          <ScreenHeader title="Watch" sidebar={false} />
        )}
        <EmptyState
          variant="plain"
          title="Watch is not available"
          detail="This environment does not support the watch screen."
        />
      </View>
    );
  }

  return <WatchScreen environmentId={environmentId} serverConfig={serverConfig} />;
}

function WatchScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig;
}) {
  const navigation = useNavigation();
  const { environmentId } = props;
  const pagesQuery = useEnvironmentQuery(
    watchEnvironment.pagesLive({ environmentId, input: { includeArchived: true } }),
  );
  const [selectedPageId, setSelectedPageId] = useState<WatchPageId | null>(null);
  const [editing, setEditing] = useState(false);
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));

  // The attention widget's stale/age math ticks on a minute clock like web.
  useEffect(() => {
    const interval = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(interval);
  }, []);

  const { active, archived } = partitionWatchPages(pagesQuery.data?.pages ?? []);
  const allPages = useMemo(() => [...active, ...archived], [active, archived]);
  const selectedPage =
    allPages.find((page) => page.id === selectedPageId) ?? active[0] ?? archived[0] ?? null;
  const selectedWidgets = useMemo(
    () =>
      selectedPage === null
        ? []
        : watchPageWidgets(pagesQuery.data?.widgets ?? [], selectedPage.id),
    [pagesQuery.data?.widgets, selectedPage],
  );
  const editingActive = editing && selectedPage !== null && selectedPage.archivedAt === null;

  const needsReload = useAtomValue(
    selectedPage === null
      ? NEVER_NEEDS_RELOAD_ATOM
      : watchEnvironment.needsReload({ environmentId, pageId: selectedPage.id }),
  );

  const setMobileProjection = useAtomCommand(watchEnvironment.setMobileProjection);
  const applyProjectionEdit = useCallback(
    (edit: WatchMobileProjectionEdit) => {
      if (selectedPage === null) return;
      const input = buildWatchWidgetSetMobileProjectionInput({
        page: selectedPage,
        widgets: selectedWidgets,
        edit,
        agentWidgetsEnabled: watchAgentWidgetsMobileSupported(props.serverConfig),
      });
      if (input === null) return;
      void setMobileProjection({ environmentId, input }).then(reportWatchWriteConflict);
    },
    [environmentId, props.serverConfig, selectedPage, selectedWidgets, setMobileProjection],
  );

  const refresh = useCallback(() => {
    setNowMinute(new Date().toISOString().slice(0, 16));
    pagesQuery.refresh();
  }, [pagesQuery]);

  const dismissReloadPrompt = useCallback(() => {
    if (selectedPage === null) return;
    appAtomRegistry.set(
      watchEnvironment.needsReload({ environmentId, pageId: selectedPage.id }),
      false,
    );
    refresh();
  }, [environmentId, refresh, selectedPage]);

  const pageMenuItems: ScreenHeaderMenuItem[] = useMemo(
    () => [
      ...active.map((page): ScreenHeaderMenuItem => ({
        id: `page:${page.id}`,
        title: page.name,
        selected: selectedPage?.id === page.id,
        onPress: () => setSelectedPageId(page.id),
      })),
      ...(archived.length === 0
        ? []
        : ([
            {
              id: "archived-pages",
              title: "Archived",
              items: archived.map((page): ScreenHeaderMenuItem => ({
                id: `page:${page.id}`,
                title: page.name,
                selected: selectedPage?.id === page.id,
                onPress: () => setSelectedPageId(page.id),
              })),
            },
          ] satisfies ScreenHeaderMenuItem[])),
    ],
    [active, archived, selectedPage?.id],
  );

  const body = (() => {
    if (pagesQuery.isPending && pagesQuery.data === null) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator />
        </View>
      );
    }
    if (pagesQuery.error !== null && pagesQuery.data === null) {
      return (
        <EmptyState
          variant="plain"
          title="Could not load pages"
          detail={pagesQuery.error}
          actionLabel="Try again"
          onAction={pagesQuery.refresh}
        />
      );
    }
    if (allPages.length === 0) {
      return (
        <EmptyState
          variant="plain"
          title="No watch pages"
          detail="Watch pages are composed on desktop. Create one there and it shows up here."
        />
      );
    }
    if (selectedPage === null) return null;
    return (
      <>
        {selectedPage.archivedAt !== null ? (
          <View className="rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
            <Text className="font-t3-medium text-sm text-warning-foreground">
              This page is archived. Its widgets are read-only.
            </Text>
          </View>
        ) : null}
        {selectedWidgets.length === 0 ? (
          <EmptyState
            variant="plain"
            title="This page is empty"
            detail="Add widgets on desktop to see them here."
          />
        ) : (
          <WatchPageColumn
            environmentId={environmentId}
            page={selectedPage}
            widgets={selectedWidgets}
            serverConfig={props.serverConfig}
            editing={editingActive}
            now={`${nowMinute}:00.000Z`}
            onProjectionEdit={applyProjectionEdit}
          />
        )}
      </>
    );
  })();

  const menus: ScreenHeaderMenu[] =
    allPages.length > 1
      ? [
          {
            title: "Pages",
            icon: "square.3.layers.3d",
            status: selectedPage?.name,
            items: pageMenuItems,
          },
        ]
      : [];
  const actions: ScreenHeaderAction[] =
    selectedPage !== null && selectedPage.archivedAt === null && selectedWidgets.length > 0
      ? [
          {
            accessibilityLabel: editingActive ? "Done editing" : "Edit widgets",
            icon: editingActive ? "checkmark" : "pencil",
            selected: editingActive,
            onPress: () => setEditing((current) => !current),
          },
        ]
      : [];

  const androidPageActions: MenuAction[] = useMemo(
    () =>
      allPages.map((page) => ({
        id: `page:${page.id}`,
        title: page.archivedAt === null ? page.name : `${page.name} (archived)`,
        state: selectedPage?.id === page.id ? ("on" as const) : ("off" as const),
      })),
    [allPages, selectedPage?.id],
  );

  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Watch"
          subtitle={selectedPage?.name ?? null}
          onBack={() => navigation.goBack()}
          actions={actions}
          trailing={
            allPages.length > 1 ? (
              <AndroidAnchoredMenu
                title="Pages"
                actions={androidPageActions}
                onPressAction={({ nativeEvent }) => {
                  const pageId = nativeEvent.event.replace(/^page:/, "");
                  const page = allPages.find((entry) => entry.id === pageId);
                  if (page !== undefined) setSelectedPageId(page.id);
                }}
              >
                <AndroidHeaderIconButton accessibilityLabel="Pages" icon="square.3.layers.3d" />
              </AndroidAnchoredMenu>
            ) : undefined
          }
        />
      ) : (
        <ScreenHeader
          title="Watch"
          subtitle={selectedPage?.name}
          sidebar={false}
          menus={menus}
          actions={actions}
        />
      )}
      <ScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pb-10 pt-4"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={refresh} tintColorClassName="accent-icon" />
        }
      >
        {needsReload && selectedPage !== null ? (
          <View className="gap-2 rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
            <Text className="font-t3-medium text-sm text-warning-foreground">
              This page changed on another client.
            </Text>
            <Text className="text-xs text-warning-foreground">
              Reload to pick up the latest layout.
            </Text>
            <MaterialButton label="Reload" tone="secondary" onPress={dismissReloadPrompt} />
          </View>
        ) : null}
        {body}
      </ScreenScrollView>
    </View>
  );
}

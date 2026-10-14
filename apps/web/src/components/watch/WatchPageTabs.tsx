import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  watchPageReorderBefore,
  watchPageReorderForDrop,
  watchPageShowsProjectBadge,
} from "@t3tools/client-runtime/state/watch-pages";
import type { ProjectId, WatchPage, WatchPageId, WatchPageScope } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

type PageMenuAction =
  | "rename"
  | "edit-layout"
  | "move-left"
  | "move-right"
  | "duplicate"
  | "move-to"
  | `move-to:${string}`
  | "new-project"
  | `new-project:${string}`
  | "open-gallery"
  | "delete";

async function showPageContextMenu(
  page: WatchPage,
  orderedPages: ReadonlyArray<WatchPage>,
  projects: ReadonlyArray<EnvironmentProject>,
  position: { x: number; y: number },
): Promise<PageMenuAction | null> {
  const api = readLocalApi();
  if (!api) return null;
  const moveLeft = watchPageReorderBefore(orderedPages, page.id, "left");
  const moveRight = watchPageReorderBefore(orderedPages, page.id, "right");
  return api.contextMenu.show<PageMenuAction>(
    [
      { id: "rename", label: "Rename", icon: "pencil" },
      { id: "edit-layout", label: "Edit layout", icon: "settings" },
      {
        id: "move-left",
        label: "Move left",
        disabled: moveLeft === undefined,
      },
      {
        id: "move-right",
        label: "Move right",
        disabled: moveRight === undefined,
      },
      { id: "duplicate", label: "Duplicate", icon: "copy" },
      // The scope toggle also serves a page bound to a project the list no
      // longer knows (a scratch project, say): "Global page" is its way back.
      ...(projects.length > 0 || page.scope === "project"
        ? [
            {
              id: "move-to" as const,
              label: "Move to project…",
              icon: "folder",
              children: [
                {
                  id: "move-to:global" as const,
                  label: "Global page",
                  checked: page.scope === "global",
                  disabled: page.scope === "global",
                },
                ...projects.map((project) => ({
                  id: `move-to:${project.id}` as const,
                  label: project.title,
                  checked: page.projectId === project.id,
                  disabled: page.projectId === project.id,
                })),
              ],
            },
          ]
        : []),
      ...(projects.length > 0
        ? [
            {
              id: "new-project" as const,
              label: "New project page",
              icon: "folder",
              children: projects.map((project) => ({
                id: `new-project:${project.id}` as const,
                label: project.title,
                icon: "folder",
              })),
            },
          ]
        : []),
      { id: "open-gallery", label: "Open gallery", separatorBefore: true },
      {
        id: "delete",
        label: "Delete",
        icon: "trash",
        destructive: true,
        separatorBefore: true,
      },
    ],
    position,
  );
}

/**
 * The inline rename field. It mounts only while `renaming` is on, so the
 * draft always starts from the page's current name — no stale text survives
 * from a previous rename.
 */
function WatchPageRenameInput(props: {
  readonly name: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draftName, setDraftName] = useState(props.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commit = () => {
    const name = draftName.trim();
    if (name.length === 0 || name === props.name) {
      props.onCancel();
      return;
    }
    props.onCommit(name);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      size="compact"
      className="w-36"
      value={draftName}
      onValueChange={(value) => setDraftName(value)}
      onFocus={() => inputRef.current?.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
      aria-label="Page name"
    />
  );
}

function WatchPageTab(props: {
  readonly page: WatchPage;
  readonly active: boolean;
  readonly editing: boolean;
  readonly renaming: boolean;
  readonly projectTitle: string | null;
  readonly onSelect: () => void;
  readonly onRenameCommit: (name: string) => void;
  readonly onRenameCancel: () => void;
  readonly onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.page.id,
    disabled: !props.editing,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...(props.editing ? listeners : {})}
      className={cn("flex shrink-0 items-center", isDragging && "relative z-10")}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          props.onContextMenu({ x: rect.left, y: rect.bottom });
        }
      }}
    >
      {props.renaming ? (
        <WatchPageRenameInput
          name={props.page.name}
          onCommit={props.onRenameCommit}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <button
          type="button"
          onClick={props.onSelect}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap",
            props.active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
          aria-current={props.active ? "page" : undefined}
        >
          <span className="truncate">{props.page.name}</span>
          {props.projectTitle !== null ? (
            <Badge size="sm" variant="secondary">
              {props.projectTitle}
            </Badge>
          ) : null}
        </button>
      )}
    </div>
  );
}

/**
 * The page tab strip in the /watch header. Tabs are click-to-switch in view
 * mode; edit mode turns on drag reorder. Right-click (or ContextMenu/F10) on
 * a tab opens the page's action menu; the trailing buttons create a blank
 * page and open the full pages menu.
 */
export function WatchPageTabs(props: {
  readonly pages: ReadonlyArray<WatchPage>;
  readonly archivedPages: ReadonlyArray<WatchPage>;
  readonly selectedPageId: WatchPageId | null;
  /** Ambient project of the viewed page; its own tabs skip the project badge. */
  readonly viewedProjectId: ProjectId | null;
  readonly editing: boolean;
  readonly renamingPageId: WatchPageId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pagesMenuOpen: boolean;
  readonly onPagesMenuOpenChange: (open: boolean) => void;
  readonly onSelectPage: (pageId: WatchPageId) => void;
  readonly onCreatePage: (projectId?: ProjectId) => void;
  readonly onRenameCommit: (pageId: WatchPageId, name: string) => void;
  readonly onRenameCancel: () => void;
  readonly onDuplicatePage: (pageId: WatchPageId) => void;
  readonly onDeletePage: (pageId: WatchPageId) => void;
  readonly onRestorePage: (pageId: WatchPageId) => void;
  readonly onUpdatePageScope: (
    pageId: WatchPageId,
    scope: WatchPageScope,
    projectId?: ProjectId,
  ) => void;
  readonly onReorderPage: (pageId: WatchPageId, beforePageId: WatchPageId | null) => void;
  readonly onStartRename: (pageId: WatchPageId) => void;
  readonly onToggleEdit: (pageId: WatchPageId) => void;
  readonly onOpenGallery: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const projectTitleById = new Map(props.projects.map((project) => [project.id, project.title]));

  const handleContextMenuAction = useCallback(
    (page: WatchPage, action: PageMenuAction) => {
      if (action === "rename") props.onStartRename(page.id);
      else if (action === "edit-layout") props.onToggleEdit(page.id);
      else if (action === "duplicate") props.onDuplicatePage(page.id);
      else if (action === "delete") props.onDeletePage(page.id);
      else if (action === "open-gallery") props.onOpenGallery();
      else if (action === "move-left" || action === "move-right") {
        const beforePageId = watchPageReorderBefore(
          props.pages,
          page.id,
          action === "move-left" ? "left" : "right",
        );
        if (beforePageId !== undefined) props.onReorderPage(page.id, beforePageId);
      } else if (action.startsWith("move-to:")) {
        const target = action.slice("move-to:".length);
        if (target === "global") props.onUpdatePageScope(page.id, "global");
        else if (target.length > 0)
          props.onUpdatePageScope(page.id, "project", target as ProjectId);
      } else if (action.startsWith("new-project:")) {
        const projectId = action.slice("new-project:".length);
        if (projectId.length > 0) props.onCreatePage(projectId as ProjectId);
      }
    },
    [props],
  );

  const openTabMenu = useCallback(
    async (page: WatchPage, position: { x: number; y: number }) => {
      const action = await showPageContextMenu(page, props.pages, props.projects, position);
      if (action !== null) handleContextMenuAction(page, action);
    },
    [handleContextMenuAction, props.pages, props.projects],
  );

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const beforePageId = watchPageReorderForDrop(
        props.pages,
        active.id as WatchPageId,
        over.id as WatchPageId,
      );
      if (beforePageId !== undefined) props.onReorderPage(active.id as WatchPageId, beforePageId);
    },
    [props],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={TAB_DRAG_MODIFIERS}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={props.pages.map((page) => page.id)}
            strategy={horizontalListSortingStrategy}
          >
            {props.pages.map((page) => (
              <WatchPageTab
                key={page.id}
                page={page}
                active={page.id === props.selectedPageId}
                editing={props.editing}
                renaming={props.renamingPageId === page.id}
                projectTitle={
                  watchPageShowsProjectBadge(page, props.viewedProjectId)
                    ? page.projectId !== null
                      ? (projectTitleById.get(page.projectId) ?? page.projectId)
                      : null
                    : null
                }
                onSelect={() => props.onSelectPage(page.id)}
                onRenameCommit={(name) => props.onRenameCommit(page.id, name)}
                onRenameCancel={props.onRenameCancel}
                onContextMenu={(position) => void openTabMenu(page, position)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="New page"
              onClick={() => props.onCreatePage()}
            >
              <PlusIcon />
            </Button>
          }
        />
        <TooltipPopup>New page</TooltipPopup>
      </Tooltip>
      <Menu open={props.pagesMenuOpen} onOpenChange={props.onPagesMenuOpenChange}>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label="All pages">
              <ChevronDownIcon />
            </Button>
          }
        />
        <MenuPopup align="end" className="min-w-48">
          <MenuGroup>
            <MenuGroupLabel>Pages</MenuGroupLabel>
            {props.pages.map((page) => (
              <MenuItem key={page.id} onClick={() => props.onSelectPage(page.id)}>
                {page.id === props.selectedPageId ? (
                  <CheckIcon className="text-foreground" />
                ) : (
                  <span className="size-4.5 sm:size-4" aria-hidden="true" />
                )}
                <MenuItemLabel>{page.name}</MenuItemLabel>
              </MenuItem>
            ))}
          </MenuGroup>
          {props.archivedPages.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>
                <MenuItemLabel>Archived pages</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>
                {props.archivedPages.map((page) => (
                  <MenuSub key={page.id}>
                    <MenuSubTrigger>
                      <MenuItemLabel>{page.name}</MenuItemLabel>
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuItem onClick={() => props.onSelectPage(page.id)}>
                        <MenuItemLabel>Open</MenuItemLabel>
                      </MenuItem>
                      <MenuItem onClick={() => props.onRestorePage(page.id)}>
                        <MenuItemLabel>Restore</MenuItemLabel>
                      </MenuItem>
                    </MenuSubPopup>
                  </MenuSub>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => props.onCreatePage()}>
            <MenuItemLabel>New page</MenuItemLabel>
          </MenuItem>
          {props.projects.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>
                <MenuItemLabel>New project page</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>
                {props.projects.map((project) => (
                  <MenuItem key={project.id} onClick={() => props.onCreatePage(project.id)}>
                    <FolderIcon />
                    <MenuItemLabel>{project.title}</MenuItemLabel>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={props.onOpenGallery}>
            <MenuItemLabel>Start from a template</MenuItemLabel>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

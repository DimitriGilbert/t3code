import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  watchWidgetSettingString,
  watchWidgetSettingStringList,
} from "@t3tools/client-runtime/state/watch-widgets";
import { DEFAULT_RUNTIME_MODE, isProviderAvailable, RuntimeMode } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
  ServerProvider,
  WatchWidget,
} from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpIcon, CircleCheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { resolveSendEnvMode } from "~/components/ChatView.logic";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { readT3ProjectFile } from "~/lib/t3ProjectFileDefaults";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { threadEnvironment } from "~/state/threads";
import { vcsEnvironment } from "~/state/vcs";

const isRuntimeMode = Schema.is(RuntimeMode);

function taskTitleFromPrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length <= 60 ? singleLine : `${singleLine.slice(0, 57).trimEnd()}…`;
}

/**
 * Compose-and-launch surface: project / provider / model pickers, a prompt
 * box, and editable template chips from the widget's settings. Starting a
 * task creates the thread and sends its first turn through the normal
 * `startTurn` bootstrap path with the same defaults the composer resolves —
 * the project's env-mode chain (`resolveNewThreadEnvMode`) decides whether
 * the turn preps a worktree and runs its setup script. The user stays on
 * the watch page and the new thread shows up in Active work.
 */
export function WatchTaskStarterWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const settings = useEnvironmentSettings(props.environmentId);
  const serverConfig = useServerConfigs().get(props.environmentId);
  // Stored settings are untyped wire data — anything outside the declared
  // option list falls back to the field's default.
  const storedRuntimeMode = watchWidgetSettingString(
    props.widget,
    "runtimeMode",
    DEFAULT_RUNTIME_MODE,
  );
  const runtimeMode = isRuntimeMode(storedRuntimeMode) ? storedRuntimeMode : DEFAULT_RUNTIME_MODE;
  const templates = watchWidgetSettingStringList(props.widget, "templates");

  const projects = props.projects;
  const providers = useMemo(
    () =>
      props.providers.filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          provider.models.length > 0,
      ),
    [props.providers],
  );

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<{ title: string; ref: ScopedThreadRef } | null>(null);

  const project =
    props.projectId !== null
      ? (projects.find((entry) => entry.id === props.projectId) ?? null)
      : (projects.find((entry) => entry.id === selectedProjectId) ?? projects[0] ?? null);
  const provider =
    providers.find((entry) => entry.instanceId === selectedInstanceId) ?? providers[0] ?? null;
  const model =
    provider?.models.find((entry) => entry.slug === selectedModel) ??
    provider?.models.find((entry) => entry.isDefault === true) ??
    provider?.models[0] ??
    null;

  // The env-mode chain can resolve "worktree" only when no tier pins
  // "local" — that is the only case needing the checkout's git state (for
  // `isRepo` and the base branch), so the status query stays off otherwise.
  const envModeMayBeWorktree =
    project !== null &&
    resolveProjectSettings(settings, project.id, project).settings.defaultThreadEnvMode !== "local";
  const gitStatusQuery = useEnvironmentQuery(
    envModeMayBeWorktree && project !== null
      ? vcsEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  );

  const canStart =
    !starting && project !== null && provider !== null && model !== null && prompt.trim() !== "";

  const onStart = async () => {
    if (!canStart || project === null || provider === null || model === null) return;
    const text = prompt.trim();
    const title = taskTitleFromPrompt(text);
    const threadId = newThreadId();
    const selection: ModelSelection = { instanceId: provider.instanceId, model: model.slug };
    const createdAt = new Date().toISOString();
    setStarting(true);
    try {
      // Composer defaults: project override → environment → t3.json →
      // built-in "local", with the new-project-folder carve-out. The file
      // read only happens when the settings tiers defer to it.
      const projectFile =
        resolveProjectSettings(settings, project.id, project).settings.defaultThreadEnvMode === null
          ? await readT3ProjectFile(props.environmentId, project.workspaceRoot)
          : null;
      const projectSettings = resolveProjectSettings(settings, project.id, project, projectFile);
      const envMode = resolveSendEnvMode({
        requestedEnvMode: resolveNewThreadEnvMode({
          projectSettings,
          workspaceRoot: project.workspaceRoot,
          newProjectsRoot: serverConfig?.newProjectsRoot,
          projectHasThreads: props.threads.some((entry) => entry.projectId === project.id),
        }),
        isGitRepo: gitStatusQuery.data?.isRepo === true,
      });
      // No branch picker here — the checkout's current branch is the base,
      // the same default the composer's branch toolbar displays.
      const baseBranch = gitStatusQuery.data?.refName ?? null;
      const isWorktree = envMode === "worktree";
      if (isWorktree && baseBranch === null) {
        toastManager.add({
          type: "warning",
          title: "Could not resolve a base branch",
          description: "The project checkout has no current branch to start the worktree from.",
        });
        return;
      }
      const result = await startTurn({
        environmentId: props.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: selection,
          titleSeed: title,
          runtimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection: selection,
              runtimeMode,
              interactionMode: "default",
              branch: isWorktree ? baseBranch : null,
              worktreePath: null,
              createdAt,
            },
            ...(isWorktree && baseBranch !== null
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch,
                    requireWorktree: true,
                    ...(projectSettings.settings.newWorktreesStartFromOrigin
                      ? { startFromOrigin: true }
                      : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        },
      });
      if (AsyncResult.isSuccess(result)) {
        setPrompt("");
        setStarted({ title, ref: scopeThreadRef(props.environmentId, threadId) });
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not start the task",
        description: error instanceof Error ? error.message : "The start request failed.",
      });
    } finally {
      setStarting(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="flex h-full min-h-8 w-full items-center justify-center">
        <p className="text-xs text-muted-foreground">No projects in this environment</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {props.projectId === null ? (
          <Select
            value={project?.id ?? null}
            onValueChange={(value) => setSelectedProjectId(value)}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="min-w-0 flex-1 truncate rounded-md border border-input bg-input/20 px-2 py-1 text-xs text-muted-foreground">
            {project?.title ?? "Project"}
          </span>
        )}
        <Select
          value={provider?.instanceId ?? null}
          onValueChange={(value) => {
            setSelectedInstanceId(value);
            setSelectedModel(null);
          }}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {providers.map((entry) => (
              <SelectItem key={entry.instanceId} value={entry.instanceId}>
                {entry.displayName ?? entry.driver}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={model?.slug ?? null}
          onValueChange={(value) => setSelectedModel(value)}
          disabled={provider === null}
        >
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {(provider?.models ?? []).map((entry) => (
              <SelectItem key={entry.slug} value={entry.slug}>
                {entry.shortName ?? entry.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <Textarea
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          setStarted(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void onStart();
          }
        }}
        placeholder="Describe the task…"
        rows={2}
        className="min-h-10 flex-1 resize-none"
      />
      <div className="flex items-center gap-1.5">
        {templates.length > 0 && (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {templates.map((template) => (
              <button
                key={template}
                type="button"
                onClick={() => {
                  setPrompt(template);
                  setStarted(null);
                }}
                className="shrink-0 truncate rounded-full border border-input bg-background px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {template.length <= 32 ? template : `${template.slice(0, 29)}…`}
              </button>
            ))}
          </div>
        )}
        {started !== null ? (
          <button
            type="button"
            onClick={() => props.onOpenThread(started.ref)}
            className="ml-auto flex shrink-0 items-center gap-1 text-2xs text-success-foreground hover:underline"
          >
            <CircleCheckIcon className="size-3" />
            Started — open thread
          </button>
        ) : null}
        <Button
          size="sm"
          className="ml-auto shrink-0"
          disabled={!canStart}
          onClick={() => void onStart()}
        >
          <ArrowUpIcon />
          {starting ? "Starting…" : "Start"}
        </Button>
      </div>
    </div>
  );
}

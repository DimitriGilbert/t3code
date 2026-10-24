import { useAtomValue } from "@effect/atom-react";
import type {
  ClankerWorkflowPath,
  ClankerDiagnostic,
  ClankerWorkflowDocument,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleXIcon,
  LayersIcon,
  ListChecksIcon,
  PlayIcon,
  SaveIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useStableCallback } from "~/hooks/useStableCallback";
import { clankerEnvironment } from "~/state/clanker";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { CLANKER_SEVERITY_ICON_CLASS, clankerWorkflowFileName } from "./clankerView";

const VALIDATE_DEBOUNCE_MS = 500;

function severityIcon(severity: ClankerDiagnostic["severity"], className = "size-3.5") {
  const colorClass = CLANKER_SEVERITY_ICON_CLASS[severity];
  if (severity === "error")
    return <CircleXIcon aria-hidden className={`${className} ${colorClass}`} />;
  if (severity === "warning")
    return <TriangleAlertIcon aria-hidden className={`${className} ${colorClass}`} />;
  return <CircleAlertIcon aria-hidden className={`${className} ${colorClass}`} />;
}

function DiagnosticsSection({ diagnostics }: { diagnostics: ReadonlyArray<ClankerDiagnostic> }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListChecksIcon aria-hidden className="size-3.5" />
        Problems
        {diagnostics.length > 0 ? (
          <span className="text-muted-foreground/70">({diagnostics.length})</span>
        ) : null}
      </h3>
      {diagnostics.length === 0 ? (
        <p className="text-xs text-muted-foreground/80">No problems found.</p>
      ) : (
        <ul className="space-y-1.5">
          {diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.severity}:${diagnostic.path ?? ""}:${diagnostic.message}`}
              className="flex items-start gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-xs"
            >
              <span className="mt-0.5 shrink-0">{severityIcon(diagnostic.severity)}</span>
              <span className="min-w-0">
                {diagnostic.path !== undefined ? (
                  <span className="block truncate font-mono text-2xs text-muted-foreground">
                    {diagnostic.path}
                  </span>
                ) : null}
                <span className="block break-words leading-5">{diagnostic.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WavesSection({ waves }: { waves: ReadonlyArray<ReadonlyArray<string>> }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <LayersIcon aria-hidden className="size-3.5" />
        Execution waves
      </h3>
      {waves.length === 0 ? (
        <p className="text-xs text-muted-foreground/80">No runnable steps yet.</p>
      ) : (
        <ol className="space-y-2">
          {waves.map((wave, index) => (
            <li key={wave.join("\0")} className="space-y-1">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/80">
                Wave {index + 1}
              </p>
              <div className="flex flex-wrap gap-1">
                {wave.map((step) => (
                  <Badge key={step} variant="outline">
                    {step}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function ClankerWorkflowEditor({
  environmentId,
  projectId,
  path,
  projectLabel,
  canRun,
  onBack,
  onRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: ClankerWorkflowPath;
  readonly projectLabel: string;
  readonly canRun: boolean;
  readonly onBack: () => void;
  readonly onRun: () => void;
}) {
  const documentQuery = useEnvironmentQuery(
    clankerEnvironment.workflow({ environmentId, input: { projectId, path } }),
  );
  const listResult = useAtomValue(
    clankerEnvironment.workflowsLive({ environmentId, input: { projectId } }),
  );
  const summary = Option.getOrNull(AsyncResult.value(listResult))?.workflows.find(
    (workflow) => workflow.path === path,
  );
  const canWrite = useAtomValue(clankerEnvironment.updateWorkflow.permissionAtom(environmentId));

  // `content` stays null until the user types, so the textarea mirrors the
  // fetched document until then. `savedDocument` overrides the query after a
  // save because the query cache is keyed only by path, not by mtime.
  const [savedDocument, setSavedDocument] = useState<ClankerWorkflowDocument | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validated, setValidated] = useState<{
    readonly text: string;
    readonly diagnostics: ReadonlyArray<ClankerDiagnostic>;
  } | null>(null);
  const requestedValidationRef = useRef("");

  const loadedDocument = savedDocument ?? documentQuery.data;
  const text = content ?? loadedDocument?.content ?? "";
  const dirty = loadedDocument !== null && text !== loadedDocument.content;
  // Only a validation that still matches the editor text wins over the saved
  // document's diagnostics; a stale result falls back to the document's.
  const diagnostics =
    validated !== null && validated.text === text && dirty
      ? validated.diagnostics
      : (loadedDocument?.diagnostics ?? []);
  const waves = loadedDocument?.waves ?? [];

  const updateWorkflow = useAtomCommand(clankerEnvironment.updateWorkflow, {
    label: "clanker workflow save",
    reportFailure: false,
  });
  const validateWorkflow = useAtomCommand(clankerEnvironment.validateWorkflow, {
    label: "clanker workflow validate",
    reportFailure: false,
  });
  const runValidation = useStableCallback(async (text: string) => {
    requestedValidationRef.current = text;
    const result = await validateWorkflow({ environmentId, input: { projectId, content: text } });
    if (result._tag === "Success" && requestedValidationRef.current === text) {
      setValidated({ text, diagnostics: result.value.diagnostics });
    }
  });

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void runValidation(text), VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, text, runValidation]);

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    const result = await updateWorkflow({
      environmentId,
      input: { projectId, path, content: text },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save workflow",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    setSavedDocument(result.value);
  };

  const fileName = clankerWorkflowFileName(path);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to clanker workflows"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <WorkspaceBreadcrumb ariaLabel="Clanker workflow breadcrumb">
          <WorkspaceBreadcrumbItem>
            <button type="button" className="truncate" onClick={onBack}>
              Clanker
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate font-mono text-sm">{fileName}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {summary !== undefined || loadedDocument !== null ? (
          <div className="hidden min-w-0 items-baseline gap-2 sm:flex">
            {summary !== undefined ? (
              <span className="truncate text-sm text-muted-foreground">
                {summary.name}
                {summary.version !== undefined ? ` · v${summary.version}` : ""}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 flex-1" />
        {summary?.description !== undefined ? (
          <span className="hidden max-w-64 truncate text-xs text-muted-foreground lg:block">
            {summary.description}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!canRun || dirty}
          title={dirty ? "Save the workflow before running it" : undefined}
          onClick={onRun}
        >
          <PlayIcon />
          Run
        </Button>
        <Button size="sm" disabled={!dirty || saving || !canWrite} onClick={() => void save()}>
          <SaveIcon />
          {saving ? "Saving…" : "Save"}
        </Button>
      </WorkspacePageHeader>

      {documentQuery.isPending && loadedDocument === null ? (
        <div className="flex min-h-0 flex-1 gap-4 p-5">
          <Skeleton className="min-h-0 flex-1" />
          <Skeleton className="hidden min-h-0 w-80 lg:block" />
        </div>
      ) : documentQuery.error !== null && loadedDocument === null ? (
        <div className="p-5">
          <Alert variant="error">
            <AlertDescription>{documentQuery.error}</AlertDescription>
          </Alert>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <textarea
              value={text}
              onChange={(event) => setContent(event.currentTarget.value)}
              disabled={!canWrite}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={`Editing ${fileName}`}
              className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-64"
            />
            <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-1.5 text-2xs text-muted-foreground">
              <span className="truncate font-mono">{path}</span>
              <span aria-hidden>·</span>
              <span>{projectLabel}</span>
              {dirty ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-warning">Unsaved changes</span>
                </>
              ) : null}
            </div>
          </div>
          <aside className="flex max-h-1/2 min-h-0 w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-border/60 p-4 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l">
            <DiagnosticsSection diagnostics={diagnostics} />
            <WavesSection waves={waves} />
          </aside>
        </div>
      )}
    </div>
  );
}

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isWatchPageRevisionConflict } from "@t3tools/client-runtime/state/watch";
import {
  firstFreeWatchPlacement,
  watchFirstPartyWidgetSpec,
  watchWidgetDisplayTitle,
  watchWidgetProvenanceMarker,
} from "@t3tools/client-runtime/state/watch-pages";
import {
  describeOversizedWidgetFile,
  parseWatchWidgetExportText,
  watchWidgetImportWarnings,
} from "@t3tools/client-runtime/state/watch-transfer";
import {
  type EnvironmentId,
  type WatchConnectorInstance,
  type WatchConnectorPack,
  type WatchPackWidgetSource,
  type WatchPage,
  type WatchWidget,
  type WatchWidgetExportDocument,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { DownloadIcon, FileJsonIcon, PlusIcon } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { watchEnvironment } from "~/state/watch";

import { reportWatchWriteResult } from "./WatchScreen";

/** What the import pipeline needs from a file; DOM File satisfies it. */
type ImportableWidgetFile = { name: string; size: number; text: () => Promise<string> };

const PROVENANCE_LABELS = {
  agent: "Agent-authored",
  pack: "Shipped in a connector pack",
} as const;

/**
 * The "or import a widget" flow under the add-widget picker: a file pick /
 * drop zone / paste box decode a `t3.watch-widget` document, a preview shows
 * what it will land as (kind, provenance, embedded source) plus non-blocking
 * warnings, and "Add to page" runs the revision-checked `watchWidgets.import`.
 * Kept trimmed — no syntax highlighting; the document is trusted only after
 * the server's own decode and re-publish pipeline.
 */
export function WatchWidgetImportDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** The page the widget lands on; import is checked against its revision. */
  readonly page: WatchPage;
  readonly widgets: ReadonlyArray<WatchWidget>;
  /** Live connector state for the preview warnings, from `connectorsLive`. */
  readonly packs: ReadonlyArray<WatchConnectorPack>;
  readonly instances: ReadonlyArray<WatchConnectorInstance>;
  readonly widgetSources: ReadonlyArray<WatchPackWidgetSource>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [document, setDocument] = useState<WatchWidgetExportDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const importRequestRef = useRef(0);
  const importWidget = useAtomCommand(watchEnvironment.importWidget);

  useEffect(() => {
    importRequestRef.current += 1;
    setIsDropTarget(false);
    if (!props.open) return;
    setText("");
    setDocument(null);
    setError(null);
    setIsReading(false);
    setIsImporting(false);
  }, [props.open]);

  const applyText = useCallback((value: string) => {
    setText(value);
    if (value.trim() === "") {
      setDocument(null);
      setError(null);
      return;
    }
    try {
      setDocument(parseWatchWidgetExportText(value));
      setError(null);
    } catch (cause) {
      setDocument(null);
      setError(cause instanceof Error ? cause.message : "That file is not a widget export.");
    }
  }, []);

  const readWidgetFile = useCallback(
    async (file: ImportableWidgetFile) => {
      const oversized = describeOversizedWidgetFile(file.size);
      if (oversized) {
        setError(oversized);
        return;
      }
      const requestId = ++importRequestRef.current;
      setIsReading(true);
      try {
        const fileText = await file.text();
        if (requestId !== importRequestRef.current) return;
        applyText(fileText);
      } catch {
        if (requestId !== importRequestRef.current) return;
        setError("Could not read that file. Paste the JSON below instead.");
      } finally {
        if (requestId === importRequestRef.current) setIsReading(false);
      }
    },
    [applyText],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file !== undefined) void readWidgetFile(file);
    },
    [readWidgetFile],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      const file = event.dataTransfer.files[0];
      if (file !== undefined) void readWidgetFile(file);
    },
    [readWidgetFile],
  );

  const warnings =
    document === null
      ? []
      : watchWidgetImportWarnings(document, {
          packs: props.packs,
          instances: props.instances,
          widgetSources: props.widgetSources,
        });
  const provenanceMarker =
    document === null
      ? null
      : watchWidgetProvenanceMarker(
          document.provenance ??
            (document.kind.startsWith("agent:") ? "agentPublished" : "firstParty"),
        );

  const handleSubmit = useCallback(() => {
    if (document === null) return;
    const spec = watchFirstPartyWidgetSpec(document.kind);
    setIsImporting(true);
    void importWidget({
      environmentId: props.environmentId,
      input: {
        pageId: props.page.id,
        expectedRevision: props.page.revision,
        document,
        placement: firstFreeWatchPlacement(
          props.widgets,
          document.sizeHint ?? spec?.defaultSize ?? { w: 4, h: 3 },
        ),
      },
    }).then((result) => {
      setIsImporting(false);
      if (AsyncResult.isSuccess(result)) {
        props.onOpenChange(false);
        const source = result.value.source;
        toastManager.add(
          source !== null && source.status === "failed"
            ? {
                type: "warning",
                title: "Widget imported, but its code failed to compile.",
                description: source.failure?.detail,
                timeout: 6000,
              }
            : { type: "success", title: "Widget added to the page.", timeout: 3000 },
        );
        return;
      }
      // A revision conflict flags the page's reload banner through the shared
      // write-result path rather than an in-dialog error.
      const failure = squashAtomCommandFailure(result);
      if (isWatchPageRevisionConflict(failure)) {
        reportWatchWriteResult(result);
        return;
      }
      setError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "The import was rejected.",
      );
    });
  }, [document, importWidget, props]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a widget</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
                isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              }}
              onDrop={handleDrop}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">Widget file</p>
                <p className="truncate text-xs text-muted-foreground">
                  Drop a t3-widget .json export
                </p>
              </div>
              <Button
                disabled={isReading}
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <DownloadIcon />
                {isReading ? "Reading…" : "Choose file"}
              </Button>
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                className="sr-only"
                onChange={handleFileChange}
                type="file"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="watch-widget-json">
                Widget JSON
              </label>
              <textarea
                aria-label="Widget JSON"
                className="block min-h-28 w-full resize-y rounded-xl border border-input bg-background p-3 font-mono text-xs leading-5 caret-foreground shadow-xs/5 outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-inset focus:ring-ring/24"
                id="watch-widget-json"
                onChange={(event) => applyText(event.currentTarget.value)}
                placeholder={
                  '{\n  "format": "t3.watch-widget",\n  "formatVersion": 1,\n  "kind": "…",\n  "config": { … }\n}'
                }
                spellCheck={false}
                value={text}
              />
            </div>
            {document === null ? null : (
              <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <FileJsonIcon className="size-4 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {watchWidgetDisplayTitle({ kind: document.kind })}
                  </p>
                  {provenanceMarker === null ? null : (
                    <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {PROVENANCE_LABELS[provenanceMarker]}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {document.kind}
                  {document.source === undefined
                    ? ""
                    : " · embeds its source, recompiled on import"}
                </p>
                {warnings.length === 0 ? null : (
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={document === null || isImporting} onClick={handleSubmit}>
                <PlusIcon />
                {isImporting ? "Importing…" : "Add to page"}
              </Button>
            </div>
            {error ? (
              <Alert aria-live="polite" variant="error">
                {error}
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

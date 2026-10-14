import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  watchFirstPartyWidgetSpec,
  watchWidgetDisplayTitle,
  type WatchWidgetSettingsField,
} from "@t3tools/client-runtime/state/watch-pages";
import type {
  WatchConnectorInstance,
  WatchWidget,
  WatchWidgetConfig,
  WatchWidgetId,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { readLocalApi } from "~/localApi";

/** Sentinels for binding values that carry no `binding` key. */
const PAGE_DEFAULT_BINDING = "__page_default__";
const NO_CONNECTOR_BINDING = "__none__";
const ALL_PROJECTS_BINDING = "*";

/**
 * The configure form swaps into the widget's content region, so the shell's
 * Done button needs a form to submit — the `form` attribute associates the
 * two without nesting.
 */
export function watchWidgetConfigFormId(widgetId: WatchWidgetId): string {
  return `watch-widget-config-${widgetId}`;
}

type DraftSettings = Record<string, unknown>;

function initialSettings(widget: WatchWidget, fields: ReadonlyArray<WatchWidgetSettingsField>) {
  const draft: DraftSettings = {};
  for (const field of fields) {
    const stored = widget.config.settings?.[field.key];
    if (stored !== undefined) {
      if (field.control === "stringList") {
        draft[field.key] = Array.isArray(stored) ? stored.join("\n") : String(stored);
      } else {
        draft[field.key] = stored;
      }
    } else if (field.control === "number") {
      draft[field.key] = field.defaultValue === undefined ? "" : String(field.defaultValue);
    } else if (field.control === "stringList") {
      draft[field.key] = Array.isArray(field.defaultValue) ? field.defaultValue.join("\n") : "";
    } else if (field.control === "switch") {
      draft[field.key] = field.defaultValue === true;
    } else {
      draft[field.key] = field.defaultValue ?? "";
    }
  }
  return draft;
}

/**
 * Reads the draft back into the `settings` record: empty strings and unset
 * numbers are dropped unless the descriptor says to persist, so the stored
 * config never carries dead keys.
 */
function collectSettings(
  fields: ReadonlyArray<WatchWidgetSettingsField>,
  draft: DraftSettings,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = draft[field.key];
    const persist = field.clearWhenEmpty === "persist";
    switch (field.control) {
      case "switch": {
        const value = raw === true;
        if (persist || value !== (field.defaultValue === true)) next[field.key] = value;
        break;
      }
      case "number": {
        const text = String(raw ?? "").trim();
        if (text === "") {
          if (persist) next[field.key] = null;
          break;
        }
        const value = Number(text);
        if (!Number.isFinite(value)) break;
        let clamped = Math.trunc(value);
        if (field.min !== undefined) clamped = Math.max(field.min, clamped);
        if (field.max !== undefined) clamped = Math.min(field.max, clamped);
        next[field.key] = clamped;
        break;
      }
      case "stringList": {
        const entries = String(raw ?? "")
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
        if (entries.length > 0 || persist) next[field.key] = entries;
        break;
      }
      case "select": {
        const value = String(raw ?? "");
        if (value !== "" || persist) next[field.key] = value;
        break;
      }
      default: {
        const value = String(raw ?? "").trim();
        if (value !== "" || persist) next[field.key] = value;
      }
    }
  }
  return next;
}

/**
 * The widget's generated configure form: the `source` binding plus the
 * kind's declared settings fields (the `deriveProviderSettingsFields`
 * pattern at widget granularity). Submits through the shell's Done button
 * via the `form` attribute; Escape asks to discard when dirty.
 */
export function WatchWidgetSettingsForm(props: {
  readonly widget: WatchWidget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly connectorInstances: ReadonlyArray<WatchConnectorInstance>;
  /** Field key a `configMismatch` error names — rendered invalid and focused. */
  readonly invalidField?: string | undefined;
  readonly onSubmit: (config: WatchWidgetConfig) => void;
  readonly onCancel: () => void;
}) {
  const { widget } = props;
  const source = widget.config.source;
  const spec = watchFirstPartyWidgetSpec(widget.kind);
  const fields = spec?.settingsFields ?? [];
  const bindable = source?.kind === "threads" || source?.kind === "connector";

  const [draftBinding, setDraftBinding] = useState<string>(
    () =>
      source?.binding ?? (source?.kind === "threads" ? PAGE_DEFAULT_BINDING : NO_CONNECTOR_BINDING),
  );
  const [draft, setDraft] = useState<DraftSettings>(() => initialSettings(widget, fields));
  const [initialBinding] = useState(() => draftBinding);
  const [initialDraft] = useState(() => initialSettings(widget, fields));
  const dirty =
    draftBinding !== initialBinding || JSON.stringify(draft) !== JSON.stringify(initialDraft);

  // Focus restore: whatever opened the configure surface (gear, error action,
  // context menu) gets focus back when the form unmounts. Captured once at
  // mount — before focus moves into the form's first field.
  const [restoreFocus] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(
    () => () => {
      restoreFocus?.focus({ preventScroll: true });
    },
    [restoreFocus],
  );

  const setDraftValue = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const bindingLabel =
    source?.kind === "threads"
      ? draftBinding === PAGE_DEFAULT_BINDING
        ? "Page default"
        : draftBinding === ALL_PROJECTS_BINDING
          ? "All projects"
          : (props.projects.find((project) => project.id === draftBinding)?.title ?? draftBinding)
      : draftBinding === NO_CONNECTOR_BINDING
        ? "No connector"
        : (props.connectorInstances.find((instance) => instance.id === draftBinding)?.name ??
          props.connectorInstances.find((instance) => instance.id === draftBinding)?.packId ??
          draftBinding);

  const handleSubmit = () => {
    // A cleared binding must drop the key outright — `exactOptionalPropertyTypes`
    // rejects `binding: undefined` and the server replaces `config` wholesale,
    // so an absent key is the only way "Page default"/"No connector" writes.
    const nextSource =
      source === undefined || !bindable
        ? source
        : draftBinding === PAGE_DEFAULT_BINDING || draftBinding === NO_CONNECTOR_BINDING
          ? (() => {
              const { binding: _dropped, ...rest } = source;
              return rest;
            })()
          : { ...source, binding: draftBinding };
    const settings = collectSettings(fields, draft);
    const config: WatchWidgetConfig = {
      ...(nextSource === undefined ? {} : { source: nextSource }),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    };
    props.onSubmit(config);
  };

  const requestClose = async () => {
    if (dirty) {
      const api = readLocalApi();
      const confirmed =
        api === undefined ||
        (await api.dialogs.confirm(`Discard changes to "${watchWidgetDisplayTitle(widget)}"?`));
      if (!confirmed) return;
    }
    props.onCancel();
  };

  const fieldRow = (field: WatchWidgetSettingsField, control: ReactNode) => {
    const invalid = props.invalidField === field.key;
    return (
      <div className="grid gap-1" key={field.key}>
        <div className="flex items-baseline gap-2">
          <Label htmlFor={`${watchWidgetConfigFormId(widget.id)}-${field.key}`}>
            {field.label}
          </Label>
          {invalid ? <span className="text-2xs text-destructive">needs attention</span> : null}
        </div>
        {control}
        {field.description === undefined ? null : (
          <p className="text-2xs text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  };

  return (
    <form
      id={watchWidgetConfigFormId(widget.id)}
      className="flex min-h-0 w-full flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Consume Escape so the page-level "leave edit mode" handler skips it.
        event.preventDefault();
        event.stopPropagation();
        void requestClose();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {source?.kind === "threads"
          ? fieldRow(
              {
                key: "__binding",
                control: "select",
                label: "Project",
              },
              <Select
                value={draftBinding}
                onValueChange={(next) => {
                  if (typeof next === "string") setDraftBinding(next);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Project binding"
                  aria-invalid={props.invalidField === "source" ? true : undefined}
                >
                  <SelectValue>{bindingLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={PAGE_DEFAULT_BINDING}>Page default</SelectItem>
                  <SelectItem value={ALL_PROJECTS_BINDING}>All projects</SelectItem>
                  {props.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>,
            )
          : null}
        {source?.kind === "connector"
          ? fieldRow(
              { key: "__binding", control: "select", label: "Connector" },
              <Select
                value={draftBinding}
                onValueChange={(next) => {
                  if (typeof next === "string") setDraftBinding(next);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Connector binding"
                  aria-invalid={props.invalidField === "source" ? true : undefined}
                >
                  <SelectValue>{bindingLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={NO_CONNECTOR_BINDING}>No connector</SelectItem>
                  {props.connectorInstances.map((instance) => (
                    <SelectItem key={instance.id} value={instance.id}>
                      {instance.name ?? instance.packId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>,
            )
          : null}
        {fields.map((field) => {
          const id = `${watchWidgetConfigFormId(widget.id)}-${field.key}`;
          const invalid = props.invalidField === field.key;
          switch (field.control) {
            case "number":
              return fieldRow(
                field,
                <Input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={field.min}
                  max={field.max}
                  value={String(draft[field.key] ?? "")}
                  aria-invalid={invalid || undefined}
                  autoFocus={invalid}
                  onChange={(event) => setDraftValue(field.key, event.target.value)}
                />,
              );
            case "textarea":
              return fieldRow(
                field,
                <Textarea
                  id={id}
                  value={String(draft[field.key] ?? "")}
                  placeholder={field.placeholder}
                  aria-invalid={invalid || undefined}
                  autoFocus={invalid}
                  onChange={(event) => setDraftValue(field.key, event.target.value)}
                />,
              );
            case "stringList":
              return fieldRow(
                field,
                <Textarea
                  id={id}
                  value={String(draft[field.key] ?? "")}
                  placeholder={field.placeholder}
                  aria-invalid={invalid || undefined}
                  autoFocus={invalid}
                  rows={3}
                  onChange={(event) => setDraftValue(field.key, event.target.value)}
                />,
              );
            case "select":
              return fieldRow(
                field,
                <Select
                  value={String(draft[field.key] ?? "")}
                  onValueChange={(next) => {
                    if (typeof next === "string") setDraftValue(field.key, next);
                  }}
                >
                  <SelectTrigger id={id} size="sm" aria-invalid={invalid || undefined}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>,
              );
            case "switch":
              return fieldRow(
                field,
                <Switch
                  id={id}
                  size="sm"
                  checked={draft[field.key] === true}
                  aria-invalid={invalid || undefined}
                  onCheckedChange={(checked) => setDraftValue(field.key, checked === true)}
                />,
              );
            default:
              return fieldRow(
                field,
                <Input
                  id={id}
                  value={String(draft[field.key] ?? "")}
                  placeholder={field.placeholder}
                  aria-invalid={invalid || undefined}
                  autoFocus={invalid}
                  onChange={(event) => setDraftValue(field.key, event.target.value)}
                />,
              );
          }
        })}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void requestClose()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!dirty}>
          Save
        </Button>
      </div>
    </form>
  );
}

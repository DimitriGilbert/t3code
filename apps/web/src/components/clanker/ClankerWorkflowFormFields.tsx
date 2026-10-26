import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  CLANKER_HOOK_KIND_LABELS,
  clankerJsonRecordError,
  emptyClankerHookDraft,
  emptyClankerJsonRow,
  nextClankerRowId,
  type ClankerHookDraft,
  type ClankerHookPhaseDraft,
  type ClankerJsonRow,
  type ClankerKeyValueRow,
  type ClankerTextRow,
} from "./clankerWorkflowForm";

const UNSET = "__unset__";

function optionKeys<T extends string>(labels: Readonly<Record<T, string>>): ReadonlyArray<T> {
  return Object.keys(labels).filter((key): key is T => Object.hasOwn(labels, key));
}

export function replaceRow<T>(rows: ReadonlyArray<T>, index: number, next: T): ReadonlyArray<T> {
  return rows.map((row, position) => (position === index ? next : row));
}

export function removeRow<T>(rows: ReadonlyArray<T>, index: number): ReadonlyArray<T> {
  return rows.filter((_, position) => position !== index);
}

export function FormField({
  label,
  hint,
  children,
  className,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint !== undefined ? <p className="text-2xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export function SubSection({
  title,
  count,
  action,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="text-xs font-medium text-foreground/80">{title}</h4>
        {count !== undefined && count > 0 ? (
          <span className="text-2xs text-muted-foreground/70">{count}</span>
        ) : null}
        <span aria-hidden className="h-px min-w-2 flex-1 bg-border/60" />
        {action}
      </div>
      {children}
    </section>
  );
}

export function RowShell({
  removeLabel,
  disabled,
  onRemove,
  children,
}: {
  readonly removeLabel: string;
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border/60 p-2">
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

export function AddRowButton({
  label,
  ariaLabel,
  disabled,
  onClick,
}: {
  readonly label: string;
  /** Set when the same visible label appears inside a nested editor. */
  readonly ariaLabel?: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      <PlusIcon />
      {label}
    </Button>
  );
}

/**
 * Indented, collapsible container for a recursive editor (an inline
 * sub-workflow or an escalation handoff). The panel unmounts while collapsed,
 * so deep nesting never expands the whole tree into the DOM.
 */
export function NestedSection({
  title,
  summary,
  open,
  disabled,
  action,
  onOpenChange,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly action?: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/24">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <ChevronDownIcon
              aria-hidden
              className={`size-3.5 shrink-0 text-icon-muted transition-transform ${open ? "" : "-rotate-90"}`}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">{summary}</span>
          </CollapsibleTrigger>
          {disabled ? null : action}
        </div>
        <CollapsiblePanel>
          <div className="border-t border-border/60 p-2">
            <div className="border-l-2 border-primary/32 pl-3">{children}</div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** Arbitrary-record field (`context`, `args`) edited as JSON text. */
export function JsonRecordField({
  label,
  hint,
  value,
  ariaLabel,
  placeholder,
  disabled,
  onChange,
}: {
  readonly label?: string;
  readonly hint?: string;
  readonly value: string;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}) {
  const error = clankerJsonRecordError(value);
  const control = (
    <>
      <Textarea
        size="sm"
        font="mono"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        aria-label={ariaLabel}
        aria-invalid={error !== null || undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error !== null ? <p className="text-2xs text-destructive-foreground">{error}</p> : null}
    </>
  );
  if (label === undefined) return <div className="min-w-0 space-y-1.5">{control}</div>;
  return (
    <FormField label={label} {...(hint === undefined ? {} : { hint })}>
      {control}
    </FormField>
  );
}

/** `conditions`: a list of arbitrary records, so each row is JSON text. */
export function JsonRecordListField({
  label,
  labelPrefix,
  hint,
  rows,
  addLabel,
  pathPrefix,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly labelPrefix: string;
  readonly hint: string;
  readonly rows: ReadonlyArray<ClankerJsonRow>;
  readonly addLabel: string;
  readonly pathPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ReadonlyArray<ClankerJsonRow>) => void;
}) {
  return (
    <SubSection
      title={label}
      count={rows.length}
      action={
        <AddRowButton
          label={addLabel}
          ariaLabel={`Add ${labelPrefix.toLowerCase()} ${label.toLowerCase()} entry`}
          disabled={disabled}
          onClick={() => onChange([...rows, emptyClankerJsonRow(nextClankerRowId(pathPrefix))])}
        />
      }
    >
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">{hint}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => (
            <li key={row.rowId}>
              <RowShell
                removeLabel={`Remove ${labelPrefix.toLowerCase()} ${label.toLowerCase()} entry ${index + 1}`}
                disabled={disabled}
                onRemove={() => onChange(removeRow(rows, index))}
              >
                <JsonRecordField
                  value={row.text}
                  ariaLabel={`${labelPrefix} ${label.toLowerCase()} entry ${index + 1}`}
                  placeholder='{"when": "outputs.build.status == ok"}'
                  disabled={disabled}
                  onChange={(text) => onChange(replaceRow(rows, index, { ...row, text }))}
                />
              </RowShell>
            </li>
          ))}
        </ul>
      )}
    </SubSection>
  );
}

export function OptionalSelect<T extends string>({
  value,
  labels,
  unsetLabel,
  ariaLabel,
  disabled,
  onChange,
}: {
  readonly value: T | "";
  readonly labels: Readonly<Record<T, string>>;
  readonly unsetLabel: string;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly onChange: (next: T | "") => void;
}) {
  const options = optionKeys(labels);
  return (
    <Select
      value={value === "" ? UNSET : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === null) return;
        if (next === UNSET) {
          onChange("");
        } else if (Object.hasOwn(labels, next)) {
          onChange(next as T);
        }
      }}
    >
      <SelectTrigger size="compact" aria-label={ariaLabel}>
        <SelectValue>
          <span className={cn("truncate", value === "" && "text-muted-foreground")}>
            {value === "" ? unsetLabel : labels[value]}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={UNSET} label={unsetLabel}>
          <span className="text-muted-foreground">{unsetLabel}</span>
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option} label={labels[option]}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function EnumSelect<T extends string>({
  value,
  labels,
  ariaLabel,
  disabled,
  onChange,
}: {
  readonly value: T;
  readonly labels: Readonly<Record<T, string>>;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly onChange: (next: T) => void;
}) {
  const options = optionKeys(labels);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && Object.hasOwn(labels, next)) onChange(next as T);
      }}
    >
      <SelectTrigger size="compact" aria-label={ariaLabel}>
        <SelectValue>
          <span className="truncate">{labels[value]}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option} value={option} label={labels[option]}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function StringListField({
  label,
  rows,
  placeholder,
  addLabel,
  itemLabel,
  pathPrefix,
  disabled,
  mono = false,
  onChange,
}: {
  readonly label: string;
  readonly rows: ReadonlyArray<ClankerTextRow>;
  readonly placeholder: string;
  readonly addLabel: string;
  readonly itemLabel: string;
  readonly pathPrefix: string;
  readonly disabled: boolean;
  readonly mono?: boolean;
  readonly onChange: (next: ReadonlyArray<ClankerTextRow>) => void;
}) {
  return (
    <SubSection
      title={label}
      count={rows.length}
      action={
        <AddRowButton
          label={addLabel}
          ariaLabel={`Add ${itemLabel.toLowerCase()}`}
          disabled={disabled}
          onClick={() => onChange([...rows, { rowId: nextClankerRowId(pathPrefix), value: "" }])}
        />
      }
    >
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => (
            <li key={row.rowId} className="flex min-w-0 items-center gap-1.5">
              <Input
                size="compact"
                font={mono ? "mono" : "default"}
                value={row.value}
                placeholder={placeholder}
                disabled={disabled}
                aria-label={`${itemLabel} ${index + 1}`}
                onChange={(event) =>
                  onChange(replaceRow(rows, index, { ...row, value: event.currentTarget.value }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${itemLabel} ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(removeRow(rows, index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SubSection>
  );
}

export function KeyValueField({
  label,
  labelPrefix,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  pathPrefix,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly labelPrefix: string;
  readonly rows: ReadonlyArray<ClankerKeyValueRow>;
  readonly keyPlaceholder: string;
  readonly valuePlaceholder: string;
  readonly addLabel: string;
  readonly pathPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ReadonlyArray<ClankerKeyValueRow>) => void;
}) {
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.key.trim() !== "") keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
  }
  const isDuplicate = (key: string) => key.trim() !== "" && (keyCounts.get(key) ?? 0) > 1;
  return (
    <SubSection
      title={label}
      count={rows.length}
      action={
        <AddRowButton
          label={addLabel}
          ariaLabel={`Add ${labelPrefix.toLowerCase()} ${label.toLowerCase()} entry`}
          disabled={disabled}
          onClick={() =>
            onChange([...rows, { rowId: nextClankerRowId(pathPrefix), key: "", value: "" }])
          }
        />
      }
    >
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => (
            <li key={row.rowId} className="flex min-w-0 items-center gap-1.5">
              <div className="w-2/5 shrink-0">
                <Input
                  size="compact"
                  font="mono"
                  value={row.key}
                  placeholder={keyPlaceholder}
                  disabled={disabled}
                  aria-label={`${labelPrefix} ${label.toLowerCase()} key ${index + 1}`}
                  aria-invalid={isDuplicate(row.key) || undefined}
                  title={
                    isDuplicate(row.key)
                      ? `Duplicate key "${row.key}": only the last entry is saved`
                      : undefined
                  }
                  onChange={(event) =>
                    onChange(replaceRow(rows, index, { ...row, key: event.currentTarget.value }))
                  }
                />
              </div>
              <Input
                size="compact"
                value={row.value}
                placeholder={valuePlaceholder}
                disabled={disabled}
                aria-label={`${labelPrefix} ${label.toLowerCase()} value ${index + 1}`}
                onChange={(event) =>
                  onChange(replaceRow(rows, index, { ...row, value: event.currentTarget.value }))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${labelPrefix.toLowerCase()} ${label.toLowerCase()} entry ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(removeRow(rows, index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SubSection>
  );
}

/** Dependencies are picked from sibling step names; stale names stay removable. */
export function DependsOnField({
  selected,
  options,
  disabled,
  onChange,
}: {
  readonly selected: ReadonlyArray<string>;
  readonly options: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}) {
  const unknown = selected.filter((name) => !options.includes(name));
  const toggle = (name: string) =>
    onChange(
      selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name],
    );
  return (
    <SubSection title="Depends on" count={selected.length}>
      {options.length === 0 && unknown.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">
          Name another step to depend on it. Steps with no dependencies run in the first wave.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((name) => {
            const active = selected.includes(name);
            return (
              <Button
                key={name}
                size="xs"
                variant={active ? "secondary" : "outline"}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => toggle(name)}
              >
                {name}
              </Button>
            );
          })}
          {unknown.map((name) => (
            <Button
              key={name}
              size="xs"
              variant="outline"
              aria-pressed
              disabled={disabled}
              title={`No step named "${name}" in this workflow`}
              onClick={() => toggle(name)}
            >
              <span className="text-destructive-foreground">{name}</span>
              <XIcon />
            </Button>
          ))}
        </div>
      )}
    </SubSection>
  );
}

/** The `{cmd, runtime}` / `{fn, args, runtime}` shape shared by hooks and `run`. */
function HookObjectFields({
  hook,
  label,
  disabled,
  onChange,
}: {
  readonly hook: ClankerHookDraft;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerHookDraft) => void;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="w-28 shrink-0">
          <EnumSelect
            value={hook.kind}
            labels={CLANKER_HOOK_KIND_LABELS}
            ariaLabel={`${label} kind`}
            disabled={disabled}
            onChange={(kind) => onChange({ ...hook, kind })}
          />
        </div>
        <Input
          size="compact"
          font="mono"
          value={hook.kind === "cmd" ? hook.cmd : hook.fn}
          placeholder={hook.kind === "cmd" ? "npm run lint" : "notifySlack"}
          disabled={disabled}
          aria-label={hook.kind === "cmd" ? `${label} command` : `${label} function`}
          onChange={(event) =>
            onChange(
              hook.kind === "cmd"
                ? { ...hook, cmd: event.currentTarget.value }
                : { ...hook, fn: event.currentTarget.value },
            )
          }
        />
        <div className="w-28 shrink-0">
          <Input
            size="compact"
            value={hook.runtime}
            placeholder="runtime"
            disabled={disabled}
            aria-label={`${label} runtime`}
            onChange={(event) => onChange({ ...hook, runtime: event.currentTarget.value })}
          />
        </div>
      </div>
      {hook.kind === "fn" ? (
        <JsonRecordField
          value={hook.args}
          ariaLabel={`${label} args`}
          placeholder='{"channel": "ops"}'
          disabled={disabled}
          onChange={(args) => onChange({ ...hook, args })}
        />
      ) : null}
      <PreservedKeysNote extra={hook.extra} />
    </>
  );
}

function HookRow({
  hook,
  index,
  labelPrefix,
  disabled,
  onChange,
  onRemove,
}: {
  readonly hook: ClankerHookDraft;
  readonly index: number;
  readonly labelPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerHookDraft) => void;
  readonly onRemove: () => void;
}) {
  const label = `${labelPrefix} hook ${index + 1}`;
  return (
    <RowShell removeLabel={`Remove ${label.toLowerCase()}`} disabled={disabled} onRemove={onRemove}>
      <HookObjectFields hook={hook} label={label} disabled={disabled} onChange={onChange} />
    </RowShell>
  );
}

/** `step.run`: one optional command or function instead of prompting an agent. */
export function RunField({
  run,
  labelPrefix,
  pathPrefix,
  disabled,
  onChange,
}: {
  readonly run: ClankerHookDraft | null;
  readonly labelPrefix: string;
  readonly pathPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerHookDraft | null) => void;
}) {
  const label = `${labelPrefix} run`;
  return (
    <SubSection
      title="Run"
      action={
        run === null ? (
          <AddRowButton
            label="Add run"
            ariaLabel={`Add ${label.toLowerCase()}`}
            disabled={disabled}
            onClick={() => onChange(emptyClankerHookDraft(nextClankerRowId(pathPrefix)))}
          />
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${label.toLowerCase()}`}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <XIcon />
          </Button>
        )
      }
    >
      {run === null ? (
        <p className="text-2xs text-muted-foreground/80">
          No run block. The T3 Code runner reports run steps as unsupported.
        </p>
      ) : (
        <div className="space-y-2 rounded-lg border border-border/60 p-2">
          <HookObjectFields
            hook={run}
            label={label}
            disabled={disabled}
            onChange={(next) => onChange(next)}
          />
        </div>
      )}
    </SubSection>
  );
}

export function HooksField({
  phases,
  pathPrefix,
  labelPrefix,
  disabled,
  onChange,
}: {
  readonly phases: ReadonlyArray<ClankerHookPhaseDraft>;
  readonly pathPrefix: string;
  readonly labelPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ReadonlyArray<ClankerHookPhaseDraft>) => void;
}) {
  const phaseCounts = new Map<string, number>();
  for (const phase of phases) {
    if (phase.phase.trim() !== "") {
      phaseCounts.set(phase.phase, (phaseCounts.get(phase.phase) ?? 0) + 1);
    }
  }
  const isDuplicate = (name: string) => name.trim() !== "" && (phaseCounts.get(name) ?? 0) > 1;
  return (
    <SubSection
      title="Hooks"
      count={phases.length}
      action={
        <AddRowButton
          label="Add phase"
          ariaLabel={`Add ${labelPrefix.toLowerCase()} hook phase`}
          disabled={disabled}
          onClick={() => {
            // A fresh phase gets a name no other phase uses, so adding two
            // phases cannot collide on "before".
            let phase = "before";
            for (let suffix = 2; phaseCounts.has(phase); suffix += 1) {
              phase = `before-${suffix}`;
            }
            onChange([...phases, { rowId: nextClankerRowId(pathPrefix), phase, hooks: [] }]);
          }}
        />
      }
    >
      {phases.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">No hooks.</p>
      ) : (
        <ul className="space-y-2">
          {phases.map((phase, phaseIndex) => (
            <li key={phase.rowId} className="space-y-2 rounded-lg border border-border/60 p-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="w-40 shrink-0">
                  <Input
                    size="compact"
                    font="mono"
                    value={phase.phase}
                    placeholder="before"
                    disabled={disabled}
                    aria-label={`${labelPrefix} hook phase ${phaseIndex + 1}`}
                    aria-invalid={isDuplicate(phase.phase) || undefined}
                    title={
                      isDuplicate(phase.phase)
                        ? `Duplicate phase "${phase.phase}": hooks merge into one phase on save`
                        : undefined
                    }
                    onChange={(event) =>
                      onChange(
                        replaceRow(phases, phaseIndex, {
                          ...phase,
                          phase: event.currentTarget.value,
                        }),
                      )
                    }
                  />
                </div>
                <span aria-hidden className="h-px min-w-2 flex-1 bg-border/60" />
                <AddRowButton
                  label="Add hook"
                  ariaLabel={`Add ${labelPrefix.toLowerCase()} hook to phase ${phaseIndex + 1}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      replaceRow(phases, phaseIndex, {
                        ...phase,
                        hooks: [
                          ...phase.hooks,
                          emptyClankerHookDraft(nextClankerRowId(phase.rowId)),
                        ],
                      }),
                    )
                  }
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${labelPrefix.toLowerCase()} hook phase ${phaseIndex + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(removeRow(phases, phaseIndex))}
                >
                  <XIcon />
                </Button>
              </div>
              {phase.hooks.length === 0 ? (
                <p className="text-2xs text-muted-foreground/80">No hooks in this phase.</p>
              ) : (
                <ul className="space-y-1.5">
                  {phase.hooks.map((hook, hookIndex) => (
                    <li key={hook.rowId}>
                      <HookRow
                        hook={hook}
                        index={hookIndex}
                        labelPrefix={labelPrefix}
                        disabled={disabled}
                        onChange={(next) =>
                          onChange(
                            replaceRow(phases, phaseIndex, {
                              ...phase,
                              hooks: replaceRow(phase.hooks, hookIndex, next),
                            }),
                          )
                        }
                        onRemove={() =>
                          onChange(
                            replaceRow(phases, phaseIndex, {
                              ...phase,
                              hooks: removeRow(phase.hooks, hookIndex),
                            }),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </SubSection>
  );
}

/** Keeps preserved-but-unrendered YAML keys visible instead of silently kept. */
export function PreservedKeysNote({
  extra,
}: {
  readonly extra: Readonly<Record<string, unknown>>;
}) {
  const keys = Object.keys(extra);
  if (keys.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground/80">
      <span>Kept from YAML:</span>
      {keys.map((key) => (
        <Badge key={key} size="sm" variant="outline">
          <span className="font-mono">{key}</span>
        </Badge>
      ))}
    </p>
  );
}

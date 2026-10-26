import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  FormField,
  HooksField,
  OptionalSelect,
  PreservedKeysNote,
  StringListField,
  SubSection,
  removeRow,
  replaceRow,
} from "./ClankerWorkflowFormFields";
import { QaField } from "./ClankerWorkflowQa";
import { ClankerWorkflowStepCard } from "./ClankerWorkflowStepCard";
import {
  CLANKER_OUTPUT_FORMAT_LABELS,
  CLANKER_TEMPLATE_ENGINE_LABELS,
  clankerDefaultsAreSet,
  clankerDependsOnOptions,
  emptyClankerDefaultsDraft,
  emptyClankerStepDraft,
  moveClankerStep,
  type ClankerWorkflowDraft,
} from "./clankerWorkflowForm";

/**
 * The workflow editor, reused for the root document and for every inline
 * sub-workflow. `labelPrefix` is set when nested, so the aria labels of a
 * sub-workflow's fields stay distinct from the ones around it.
 */
export function ClankerWorkflowForm({
  draft,
  labelPrefix,
  disabled,
  onChange,
}: {
  readonly draft: ClankerWorkflowDraft;
  readonly labelPrefix?: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerWorkflowDraft) => void;
}) {
  const [collapsedSteps, setCollapsedSteps] = useState<ReadonlySet<string>>(new Set());
  const [defaultsOpen, setDefaultsOpen] = useState(clankerDefaultsAreSet(draft.defaults));

  const setStepExpanded = (rowId: string, expanded: boolean) => {
    const next = new Set(collapsedSteps);
    if (expanded) next.delete(rowId);
    else next.add(rowId);
    setCollapsedSteps(next);
  };

  const nested = labelPrefix !== undefined;
  const fieldLabel = (suffix: string) =>
    nested ? `${labelPrefix} ${suffix}` : `Workflow ${suffix}`;
  const defaultLabel = (suffix: string) =>
    nested ? `${labelPrefix} default ${suffix}` : `Default ${suffix}`;
  const defaultsPrefix = nested ? `${labelPrefix} defaults` : "Defaults";
  const stepLabel = (index: number) =>
    nested ? `${labelPrefix} step ${index + 1}` : `Step ${index + 1}`;

  const defaults = draft.defaults;
  const defaultsSet = clankerDefaultsAreSet(defaults);

  return (
    <div className={nested ? "space-y-4" : "space-y-5 p-4"}>
      <section className="space-y-4 rounded-xl border border-border/60 p-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <FormField label="Name">
            <Input
              size="compact"
              value={draft.name}
              placeholder="release"
              disabled={disabled}
              aria-label={fieldLabel("name")}
              onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="Version">
            <Input
              size="compact"
              font="mono"
              value={draft.version}
              placeholder="1"
              disabled={disabled}
              aria-label={fieldLabel("version")}
              onChange={(event) => onChange({ ...draft, version: event.currentTarget.value })}
            />
          </FormField>
        </div>
        <FormField label="Description">
          <Textarea
            size="sm"
            value={draft.description}
            placeholder="What this workflow does."
            disabled={disabled}
            aria-label={fieldLabel("description")}
            onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
          />
        </FormField>
        <StringListField
          label="Secrets"
          rows={draft.secrets}
          placeholder="OPENAI_API_KEY"
          addLabel="Add secret"
          itemLabel={nested ? `${labelPrefix} secret` : "Secret"}
          pathPrefix="secrets"
          disabled={disabled}
          mono
          onChange={(secrets) => onChange({ ...draft, secrets })}
        />
        <PreservedKeysNote extra={draft.extra} />
      </section>

      <div className="rounded-xl border border-border/60">
        <Collapsible open={defaultsOpen} onOpenChange={setDefaultsOpen}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 w-full items-center gap-2 rounded-xl px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <ChevronDownIcon
              aria-hidden
              className={`size-3.5 shrink-0 text-icon-muted transition-transform ${defaultsOpen ? "" : "-rotate-90"}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">Defaults</span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {defaultsSet ? "Applied to every step" : "Not set"}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-4 border-t border-border/60 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Model">
                  <Input
                    size="compact"
                    font="mono"
                    value={defaults.model}
                    placeholder="gpt-5-codex"
                    disabled={disabled}
                    aria-label={defaultLabel("model")}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        defaults: { ...defaults, model: event.currentTarget.value },
                      })
                    }
                  />
                </FormField>
                <FormField label="Provider">
                  <Input
                    size="compact"
                    font="mono"
                    value={defaults.provider}
                    placeholder="codex"
                    disabled={disabled}
                    aria-label={defaultLabel("provider")}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        defaults: { ...defaults, provider: event.currentTarget.value },
                      })
                    }
                  />
                </FormField>
                <div className="grid grid-cols-3 gap-2">
                  <FormField label="Timeout">
                    <Input
                      size="compact"
                      type="number"
                      min={1}
                      value={defaults.timeout}
                      placeholder="600"
                      disabled={disabled}
                      aria-label={defaultLabel("timeout")}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          defaults: {
                            ...defaults,
                            timeout: event.currentTarget.value,
                          },
                        })
                      }
                    />
                  </FormField>
                  <FormField label="Retry">
                    <Input
                      size="compact"
                      type="number"
                      min={0}
                      value={defaults.retry}
                      placeholder="0"
                      disabled={disabled}
                      aria-label={defaultLabel("retry")}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          defaults: { ...defaults, retry: event.currentTarget.value },
                        })
                      }
                    />
                  </FormField>
                  <FormField label="Parallel">
                    <Input
                      size="compact"
                      type="number"
                      min={1}
                      value={defaults.concurrency}
                      placeholder="1"
                      disabled={disabled}
                      aria-label={defaultLabel("concurrency")}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          defaults: {
                            ...defaults,
                            concurrency: event.currentTarget.value,
                          },
                        })
                      }
                    />
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <FormField label="Template engine">
                    <OptionalSelect
                      value={defaults.templateEngine}
                      labels={CLANKER_TEMPLATE_ENGINE_LABELS}
                      unsetLabel="Not set"
                      ariaLabel={defaultLabel("template engine")}
                      disabled={disabled}
                      onChange={(templateEngine) =>
                        onChange({
                          ...draft,
                          defaults: { ...defaults, templateEngine },
                        })
                      }
                    />
                  </FormField>
                  <FormField label="Output format">
                    <OptionalSelect
                      value={defaults.outputFormat}
                      labels={CLANKER_OUTPUT_FORMAT_LABELS}
                      unsetLabel="Not set"
                      ariaLabel={defaultLabel("output format")}
                      disabled={disabled}
                      onChange={(outputFormat) =>
                        onChange({ ...draft, defaults: { ...defaults, outputFormat } })
                      }
                    />
                  </FormField>
                </div>
              </div>
              <HooksField
                phases={defaults.hooks}
                pathPrefix="defaults/hooks"
                labelPrefix={defaultsPrefix}
                disabled={disabled}
                onChange={(hooks) => onChange({ ...draft, defaults: { ...defaults, hooks } })}
              />
              <QaField
                qa={defaults.qa}
                pathPrefix="defaults/qa"
                labelPrefix={defaultsPrefix}
                disabled={disabled}
                onChange={(qa) => onChange({ ...draft, defaults: { ...defaults, qa } })}
              />
              <PreservedKeysNote extra={defaults.extra} />
              {defaultsSet ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Clear ${defaultsPrefix.toLowerCase()}`}
                  disabled={disabled}
                  onClick={() => onChange({ ...draft, defaults: emptyClankerDefaultsDraft() })}
                >
                  Clear defaults
                </Button>
              ) : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>

      <SubSection
        title="Steps"
        count={draft.steps.length}
        action={
          <Button
            size="xs"
            variant="outline"
            aria-label={nested ? `Add ${labelPrefix} step` : undefined}
            disabled={disabled}
            onClick={() => onChange({ ...draft, steps: [...draft.steps, emptyClankerStepDraft()] })}
          >
            <PlusIcon />
            Add step
          </Button>
        }
      >
        {draft.steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
            A workflow needs at least one step.
          </p>
        ) : (
          <ul className="space-y-2">
            {draft.steps.map((step, index) => (
              <li key={step.rowId}>
                <ClankerWorkflowStepCard
                  step={step}
                  labelPrefix={stepLabel(index)}
                  fallbackTitle={stepLabel(index)}
                  dependsOnOptions={clankerDependsOnOptions(draft, index)}
                  expanded={!collapsedSteps.has(step.rowId)}
                  disabled={disabled}
                  canMoveUp={index > 0}
                  canMoveDown={index < draft.steps.length - 1}
                  onExpandedChange={(expanded) => setStepExpanded(step.rowId, expanded)}
                  onChange={(next) =>
                    onChange({ ...draft, steps: replaceRow(draft.steps, index, next) })
                  }
                  onMove={(delta) => onChange(moveClankerStep(draft, index, delta))}
                  onRemove={() => onChange({ ...draft, steps: removeRow(draft.steps, index) })}
                />
              </li>
            ))}
          </ul>
        )}
      </SubSection>
    </div>
  );
}

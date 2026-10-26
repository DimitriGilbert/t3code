import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileTextIcon,
  MessageSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ClankerWorkflowForm } from "./ClankerWorkflowForm";
import {
  AddRowButton,
  DependsOnField,
  EnumSelect,
  FormField,
  HooksField,
  JsonRecordField,
  JsonRecordListField,
  KeyValueField,
  NestedSection,
  OptionalSelect,
  PreservedKeysNote,
  RowShell,
  RunField,
  StringListField,
  SubSection,
  removeRow,
  replaceRow,
} from "./ClankerWorkflowFormFields";
import { QaField } from "./ClankerWorkflowQa";
import {
  CLANKER_OUTPUT_FORMAT_LABELS,
  CLANKER_PROMPT_KIND_LABELS,
  CLANKER_TEMPLATE_ENGINE_LABELS,
  emptyClankerModelDraft,
  emptyClankerPromptDraft,
  emptyClankerSubWorkflowDraft,
  nextClankerRowId,
  type ClankerStepDraft,
} from "./clankerWorkflowForm";

/**
 * One step, at any nesting depth. `labelPrefix` keeps the aria labels of a
 * nested step distinct from its ancestors'; omitting `onMove`/`onRemove` drops
 * the reordering controls a lone nested step has no use for.
 */
export function ClankerWorkflowStepCard({
  step,
  labelPrefix,
  fallbackTitle,
  dependsOnOptions,
  expanded,
  disabled,
  canMoveUp = false,
  canMoveDown = false,
  onExpandedChange,
  onChange,
  onMove,
  onRemove,
}: {
  readonly step: ClankerStepDraft;
  readonly labelPrefix: string;
  readonly fallbackTitle: string;
  readonly dependsOnOptions: ReadonlyArray<string>;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onChange: (next: ClankerStepDraft) => void;
  readonly onMove?: (delta: number) => void;
  readonly onRemove?: () => void;
}) {
  const [subWorkflowOpen, setSubWorkflowOpen] = useState(false);
  const title = step.name.trim() === "" ? fallbackTitle : step.name;
  const promptSummary = step.prompts.length === 1 ? "1 prompt" : `${step.prompts.length} prompts`;
  const path = step.rowId;
  const stepLabel = labelPrefix;
  const subWorkflow = step.subWorkflow;

  return (
    <div className="rounded-xl border border-border/60">
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
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
              className={`size-3.5 shrink-0 text-icon-muted transition-transform ${expanded ? "" : "-rotate-90"}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">{promptSummary}</span>
            {step.dependsOn.length > 0 ? (
              <Badge size="sm" variant="outline">
                {step.dependsOn.length === 1
                  ? `after ${step.dependsOn[0]}`
                  : `after ${step.dependsOn.length} steps`}
              </Badge>
            ) : null}
          </CollapsibleTrigger>
          {onMove !== undefined ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${title} up`}
                disabled={disabled || !canMoveUp}
                onClick={() => onMove(-1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${title} down`}
                disabled={disabled || !canMoveDown}
                onClick={() => onMove(1)}
              >
                <ChevronDownIcon />
              </Button>
            </>
          ) : null}
          {onRemove !== undefined ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete ${title}`}
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
        {/* The panel unmounts while collapsed, so nesting stays out of the DOM. */}
        <CollapsiblePanel>
          <div className="space-y-4 border-t border-border/60 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Name">
                <Input
                  size="compact"
                  font="mono"
                  value={step.name}
                  placeholder="build"
                  disabled={disabled}
                  aria-label={`${stepLabel} name`}
                  onChange={(event) => onChange({ ...step, name: event.currentTarget.value })}
                />
              </FormField>
              <FormField label="Description">
                <Input
                  size="compact"
                  value={step.description}
                  placeholder="What this step does"
                  disabled={disabled}
                  aria-label={`${stepLabel} description`}
                  onChange={(event) =>
                    onChange({ ...step, description: event.currentTarget.value })
                  }
                />
              </FormField>
              <FormField label="Agent" hint="Agent definition file; the T3 Code runner ignores it.">
                <Input
                  size="compact"
                  font="mono"
                  value={step.agent}
                  placeholder="reviewer"
                  disabled={disabled}
                  aria-label={`${stepLabel} agent`}
                  onChange={(event) => onChange({ ...step, agent: event.currentTarget.value })}
                />
              </FormField>
              <FormField
                label="Sub-workflow"
                hint={
                  subWorkflow === null
                    ? "Path to another workflow file to run instead."
                    : "Ignored while the sub-workflow below is inline."
                }
              >
                <Input
                  size="compact"
                  font="mono"
                  value={step.workflowRef}
                  placeholder=".clanker/workflows/review.yaml"
                  disabled={
                    disabled || subWorkflow !== null || step.extra["workflow"] !== undefined
                  }
                  aria-label={`${stepLabel} sub-workflow`}
                  onChange={(event) =>
                    onChange({ ...step, workflowRef: event.currentTarget.value })
                  }
                />
              </FormField>
              <FormField label="Condition">
                <Input
                  size="compact"
                  font="mono"
                  value={step.condition}
                  placeholder="outputs.build.status == 'ok'"
                  disabled={disabled}
                  aria-label={`${stepLabel} condition`}
                  onChange={(event) => onChange({ ...step, condition: event.currentTarget.value })}
                />
              </FormField>
              <div className="grid grid-cols-3 gap-2">
                <FormField label="Timeout">
                  <Input
                    size="compact"
                    type="number"
                    min={1}
                    value={step.timeout}
                    placeholder="600"
                    disabled={disabled}
                    aria-label={`${stepLabel} timeout`}
                    onChange={(event) => onChange({ ...step, timeout: event.currentTarget.value })}
                  />
                </FormField>
                <FormField label="Retry">
                  <Input
                    size="compact"
                    type="number"
                    min={0}
                    value={step.retry}
                    placeholder="0"
                    disabled={disabled}
                    aria-label={`${stepLabel} retry`}
                    onChange={(event) => onChange({ ...step, retry: event.currentTarget.value })}
                  />
                </FormField>
                <FormField label="Parallel">
                  <Input
                    size="compact"
                    type="number"
                    min={1}
                    value={step.concurrency}
                    placeholder="1"
                    disabled={disabled}
                    aria-label={`${stepLabel} concurrency`}
                    onChange={(event) =>
                      onChange({ ...step, concurrency: event.currentTarget.value })
                    }
                  />
                </FormField>
              </div>
              <FormField label="Template engine">
                <OptionalSelect
                  value={step.templateEngine}
                  labels={CLANKER_TEMPLATE_ENGINE_LABELS}
                  unsetLabel="Inherit from defaults"
                  ariaLabel={`${stepLabel} template engine`}
                  disabled={disabled}
                  onChange={(templateEngine) => onChange({ ...step, templateEngine })}
                />
              </FormField>
              <FormField label="Output format">
                <OptionalSelect
                  value={step.outputFormat}
                  labels={CLANKER_OUTPUT_FORMAT_LABELS}
                  unsetLabel="Inherit from defaults"
                  ariaLabel={`${stepLabel} output format`}
                  disabled={disabled}
                  onChange={(outputFormat) => onChange({ ...step, outputFormat })}
                />
              </FormField>
            </div>

            <DependsOnField
              selected={step.dependsOn}
              options={dependsOnOptions}
              disabled={disabled}
              onChange={(dependsOn) => onChange({ ...step, dependsOn })}
            />

            <div className="space-y-2">
              <JsonRecordListField
                label="Conditions"
                labelPrefix={stepLabel}
                hint="No structured conditions. The T3 Code runner reports them as unsupported."
                rows={step.conditions}
                addLabel="Add condition"
                pathPrefix={`${path}/conditions`}
                disabled={disabled}
                onChange={(conditions) => onChange({ ...step, conditions })}
              />
              {step.conditions.length > 0 ? (
                <div className="sm:w-48">
                  <FormField label="Conditions mode">
                    <Input
                      size="compact"
                      font="mono"
                      value={step.conditionsMode}
                      placeholder="all"
                      disabled={disabled}
                      aria-label={`${stepLabel} conditions mode`}
                      onChange={(event) =>
                        onChange({ ...step, conditionsMode: event.currentTarget.value })
                      }
                    />
                  </FormField>
                </div>
              ) : null}
            </div>

            <RunField
              run={step.run}
              labelPrefix={stepLabel}
              pathPrefix={`${path}/run`}
              disabled={disabled}
              onChange={(run) => onChange({ ...step, run })}
            />

            <SubSection
              title="Sub-workflow"
              action={
                subWorkflow === null ? (
                  <AddRowButton
                    label="Inline sub-workflow"
                    ariaLabel={`Inline ${stepLabel.toLowerCase()} sub-workflow`}
                    disabled={disabled}
                    onClick={() => {
                      onChange({ ...step, subWorkflow: emptyClankerSubWorkflowDraft() });
                      setSubWorkflowOpen(true);
                    }}
                  />
                ) : null
              }
            >
              {subWorkflow === null ? (
                <p className="text-2xs text-muted-foreground/80">
                  {step.workflowRef.trim() === ""
                    ? "No sub-workflow. Reference one by path above, or inline a whole workflow here."
                    : `Runs the workflow at ${step.workflowRef}.`}
                </p>
              ) : (
                <NestedSection
                  title="Inline sub-workflow"
                  summary={
                    subWorkflow.steps.length === 1 ? "1 step" : `${subWorkflow.steps.length} steps`
                  }
                  open={subWorkflowOpen}
                  disabled={disabled}
                  onOpenChange={setSubWorkflowOpen}
                  action={
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${stepLabel.toLowerCase()} inline sub-workflow`}
                      disabled={disabled}
                      onClick={() => onChange({ ...step, subWorkflow: null })}
                    >
                      Use a path
                    </Button>
                  }
                >
                  <ClankerWorkflowForm
                    draft={subWorkflow}
                    labelPrefix={`${stepLabel} sub-workflow`}
                    disabled={disabled}
                    onChange={(next) => onChange({ ...step, subWorkflow: next })}
                  />
                </NestedSection>
              )}
            </SubSection>

            <SubSection
              title="Prompts"
              count={step.prompts.length}
              action={
                <AddRowButton
                  label="Add prompt"
                  ariaLabel={`Add ${stepLabel.toLowerCase()} prompt`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...step,
                      prompts: [
                        ...step.prompts,
                        emptyClankerPromptDraft(nextClankerRowId(`${path}/prompts`)),
                      ],
                    })
                  }
                />
              }
            >
              {step.prompts.length === 0 ? (
                <p className="text-2xs text-muted-foreground/80">
                  A step needs at least one prompt unless it runs an agent or sub-workflow. Each
                  prompt fans out into its own thread.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {step.prompts.map((prompt, promptIndex) => (
                    <li key={prompt.rowId}>
                      <RowShell
                        removeLabel={`Remove ${stepLabel.toLowerCase()} prompt ${promptIndex + 1}`}
                        disabled={disabled}
                        onRemove={() =>
                          onChange({ ...step, prompts: removeRow(step.prompts, promptIndex) })
                        }
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {prompt.kind === "text" ? (
                            <MessageSquareIcon aria-hidden className="size-3.5 text-icon-muted" />
                          ) : (
                            <FileTextIcon aria-hidden className="size-3.5 text-icon-muted" />
                          )}
                          <div className="w-36 shrink-0">
                            <EnumSelect
                              value={prompt.kind}
                              labels={CLANKER_PROMPT_KIND_LABELS}
                              ariaLabel={`${stepLabel} prompt ${promptIndex + 1} kind`}
                              disabled={disabled}
                              onChange={(kind) =>
                                onChange({
                                  ...step,
                                  prompts: replaceRow(step.prompts, promptIndex, {
                                    ...prompt,
                                    kind,
                                  }),
                                })
                              }
                            />
                          </div>
                          <span className="truncate text-2xs text-muted-foreground/80">
                            Thread {promptIndex + 1}
                          </span>
                        </div>
                        {prompt.kind === "text" ? (
                          <Textarea
                            size="sm"
                            value={prompt.text}
                            placeholder="Tell the agent what to do in this thread."
                            disabled={disabled}
                            aria-label={`${stepLabel} prompt ${promptIndex + 1} text`}
                            onChange={(event) =>
                              onChange({
                                ...step,
                                prompts: replaceRow(step.prompts, promptIndex, {
                                  ...prompt,
                                  text: event.currentTarget.value,
                                }),
                              })
                            }
                          />
                        ) : (
                          <Input
                            size="compact"
                            font="mono"
                            value={prompt.file}
                            placeholder=".clanker/prompts/review.md"
                            disabled={disabled}
                            aria-label={`${stepLabel} prompt ${promptIndex + 1} file`}
                            onChange={(event) =>
                              onChange({
                                ...step,
                                prompts: replaceRow(step.prompts, promptIndex, {
                                  ...prompt,
                                  file: event.currentTarget.value,
                                }),
                              })
                            }
                          />
                        )}
                        <JsonRecordField
                          label="Context"
                          value={prompt.context}
                          ariaLabel={`${stepLabel} prompt ${promptIndex + 1} context`}
                          placeholder='{"ticket": "T-1"}'
                          disabled={disabled}
                          onChange={(context) =>
                            onChange({
                              ...step,
                              prompts: replaceRow(step.prompts, promptIndex, {
                                ...prompt,
                                context,
                              }),
                            })
                          }
                        />
                        <PreservedKeysNote extra={prompt.extra} />
                      </RowShell>
                    </li>
                  ))}
                </ul>
              )}
            </SubSection>

            <SubSection
              title="Models"
              count={step.models.length}
              action={
                <AddRowButton
                  label="Add model"
                  ariaLabel={`Add ${stepLabel.toLowerCase()} model`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...step,
                      models: [
                        ...step.models,
                        emptyClankerModelDraft(nextClankerRowId(`${path}/models`)),
                      ],
                    })
                  }
                />
              }
            >
              {step.models.length === 0 ? (
                <p className="text-2xs text-muted-foreground/80">
                  Runs on the model picked when the run starts.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {step.models.map((model, modelIndex) => (
                    <li key={model.rowId}>
                      <RowShell
                        removeLabel={`Remove ${stepLabel.toLowerCase()} model ${modelIndex + 1}`}
                        disabled={disabled}
                        onRemove={() =>
                          onChange({ ...step, models: removeRow(step.models, modelIndex) })
                        }
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Input
                            size="compact"
                            font="mono"
                            value={model.id}
                            placeholder="gpt-5-codex"
                            disabled={disabled}
                            aria-label={`${stepLabel} model ${modelIndex + 1} id`}
                            onChange={(event) =>
                              onChange({
                                ...step,
                                models: replaceRow(step.models, modelIndex, {
                                  ...model,
                                  id: event.currentTarget.value,
                                }),
                              })
                            }
                          />
                          <Input
                            size="compact"
                            value={model.provider}
                            placeholder="provider"
                            disabled={disabled}
                            aria-label={`${stepLabel} model ${modelIndex + 1} provider`}
                            onChange={(event) =>
                              onChange({
                                ...step,
                                models: replaceRow(step.models, modelIndex, {
                                  ...model,
                                  provider: event.currentTarget.value,
                                }),
                              })
                            }
                          />
                          <Input
                            size="compact"
                            value={model.harness}
                            placeholder="harness"
                            disabled={disabled}
                            aria-label={`${stepLabel} model ${modelIndex + 1} harness`}
                            onChange={(event) =>
                              onChange({
                                ...step,
                                models: replaceRow(step.models, modelIndex, {
                                  ...model,
                                  harness: event.currentTarget.value,
                                }),
                              })
                            }
                          />
                        </div>
                        <PreservedKeysNote extra={model.extra} />
                      </RowShell>
                    </li>
                  ))}
                </ul>
              )}
            </SubSection>

            <div className="grid gap-4 lg:grid-cols-2">
              <KeyValueField
                label="Inputs"
                labelPrefix={stepLabel}
                rows={step.inputs}
                keyPlaceholder="ref"
                valuePlaceholder="main"
                addLabel="Add input"
                pathPrefix={`${path}/inputs`}
                disabled={disabled}
                onChange={(inputs) => onChange({ ...step, inputs })}
              />
              <KeyValueField
                label="Outputs"
                labelPrefix={stepLabel}
                rows={step.outputs}
                keyPlaceholder="artifact"
                valuePlaceholder="dist.tgz"
                addLabel="Add output"
                pathPrefix={`${path}/outputs`}
                disabled={disabled}
                onChange={(outputs) => onChange({ ...step, outputs })}
              />
              <KeyValueField
                label="Environment"
                labelPrefix={stepLabel}
                rows={step.env}
                keyPlaceholder="NODE_ENV"
                valuePlaceholder="production"
                addLabel="Add variable"
                pathPrefix={`${path}/env`}
                disabled={disabled}
                onChange={(env) => onChange({ ...step, env })}
              />
              <KeyValueField
                label="Tags"
                labelPrefix={stepLabel}
                rows={step.tags}
                keyPlaceholder="team"
                valuePlaceholder="infra"
                addLabel="Add tag"
                pathPrefix={`${path}/tags`}
                disabled={disabled}
                onChange={(tags) => onChange({ ...step, tags })}
              />
              <StringListField
                label="Skills"
                rows={step.skills}
                placeholder="typescript"
                addLabel="Add skill"
                itemLabel={`${stepLabel} skill`}
                pathPrefix={`${path}/skills`}
                disabled={disabled}
                mono
                onChange={(skills) => onChange({ ...step, skills })}
              />
            </div>

            <HooksField
              phases={step.hooks}
              pathPrefix={`${path}/hooks`}
              labelPrefix={stepLabel}
              disabled={disabled}
              onChange={(hooks) => onChange({ ...step, hooks })}
            />
            <QaField
              qa={step.qa}
              pathPrefix={`${path}/qa`}
              labelPrefix={stepLabel}
              disabled={disabled}
              onChange={(qa) => onChange({ ...step, qa })}
            />
            <PreservedKeysNote extra={step.extra} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

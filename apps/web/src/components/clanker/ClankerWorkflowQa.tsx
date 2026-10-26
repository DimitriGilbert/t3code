import { useState } from "react";

import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { ClankerWorkflowForm } from "./ClankerWorkflowForm";
import {
  AddRowButton,
  EnumSelect,
  FormField,
  JsonRecordField,
  NestedSection,
  OptionalSelect,
  PreservedKeysNote,
  RowShell,
  SubSection,
  removeRow,
  replaceRow,
} from "./ClankerWorkflowFormFields";
import { ClankerWorkflowStepCard } from "./ClankerWorkflowStepCard";
import {
  CLANKER_CHECK_ON_FAIL_LABELS,
  CLANKER_ESCALATE_REF_LABELS,
  CLANKER_ESCALATE_TYPE_LABELS,
  CLANKER_QA_CHECK_LABELS,
  CLANKER_QA_ON_FAIL_LABELS,
  emptyClankerEscalateDraft,
  emptyClankerQaCheckDraft,
  emptyClankerStepDraft,
  emptyClankerSubWorkflowDraft,
  nextClankerRowId,
  type ClankerEscalateDraft,
  type ClankerEscalateRefKind,
  type ClankerQaCheckDraft,
  type ClankerQaDraft,
} from "./clankerWorkflowForm";

function QaCheckRow({
  check,
  index,
  labelPrefix,
  disabled,
  onChange,
  onRemove,
}: {
  readonly check: ClankerQaCheckDraft;
  readonly index: number;
  readonly labelPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerQaCheckDraft) => void;
  readonly onRemove: () => void;
}) {
  const label = `${labelPrefix} check ${index + 1}`;
  return (
    <RowShell removeLabel={`Remove ${label.toLowerCase()}`} disabled={disabled} onRemove={onRemove}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="w-36 shrink-0">
          <EnumSelect
            value={check.kind}
            labels={CLANKER_QA_CHECK_LABELS}
            ariaLabel={`${label} type`}
            disabled={disabled}
            onChange={(kind) => onChange({ ...check, kind })}
          />
        </div>
        {check.kind === "ref" ? (
          <Input
            size="compact"
            font="mono"
            value={check.target}
            placeholder="shared/lint"
            disabled={disabled}
            aria-label={`${label} target`}
            onChange={(event) => onChange({ ...check, target: event.currentTarget.value })}
          />
        ) : check.kind === "cmd" ? (
          <>
            <Input
              size="compact"
              font="mono"
              value={check.cmd}
              placeholder="npm test"
              disabled={disabled}
              aria-label={`${label} command`}
              onChange={(event) => onChange({ ...check, cmd: event.currentTarget.value })}
            />
            <div className="w-28 shrink-0">
              <Input
                size="compact"
                value={check.runtime}
                placeholder="runtime"
                disabled={disabled}
                aria-label={`${label} runtime`}
                onChange={(event) => onChange({ ...check, runtime: event.currentTarget.value })}
              />
            </div>
          </>
        ) : check.kind === "fn" ? (
          <Input
            size="compact"
            font="mono"
            value={check.fn}
            placeholder="auditOutput"
            disabled={disabled}
            aria-label={`${label} function`}
            onChange={(event) => onChange({ ...check, fn: event.currentTarget.value })}
          />
        ) : (
          <Input
            size="compact"
            value={check.name}
            placeholder="sanity"
            disabled={disabled}
            aria-label={`${label} name`}
            onChange={(event) => onChange({ ...check, name: event.currentTarget.value })}
          />
        )}
        <div className="w-40 shrink-0">
          <OptionalSelect
            value={check.onFail}
            labels={CLANKER_CHECK_ON_FAIL_LABELS}
            unsetLabel="Inherit on fail"
            ariaLabel={`${label} on fail`}
            disabled={disabled}
            onChange={(next) => onChange({ ...check, onFail: next })}
          />
        </div>
      </div>
      {check.kind === "inline" ? (
        <Textarea
          size="sm"
          value={check.prompt}
          placeholder="Ask the model whether the step output is acceptable."
          disabled={disabled}
          aria-label={`${label} prompt`}
          onChange={(event) => onChange({ ...check, prompt: event.currentTarget.value })}
        />
      ) : null}
      {check.kind === "fn" ? (
        <JsonRecordField
          value={check.args}
          ariaLabel={`${label} args`}
          placeholder='{"depth": 2}'
          disabled={disabled}
          onChange={(args) => onChange({ ...check, args })}
        />
      ) : null}
      <PreservedKeysNote extra={check.extra} />
    </RowShell>
  );
}

/** A handoff `ref` recurses into a whole workflow or a single step. */
function EscalateRefEditor({
  handler,
  label,
  disabled,
  onChange,
}: {
  readonly handler: ClankerEscalateDraft;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerEscalateDraft) => void;
}) {
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [stepOpen, setStepOpen] = useState(false);

  if (handler.refKind === "path") {
    return (
      <Input
        size="compact"
        font="mono"
        value={handler.refPath}
        placeholder="shared/triage"
        disabled={disabled}
        aria-label={`${label} reference`}
        onChange={(event) => onChange({ ...handler, refPath: event.currentTarget.value })}
      />
    );
  }
  if (handler.refKind === "workflow" && handler.refWorkflow !== null) {
    const workflow = handler.refWorkflow;
    return (
      <NestedSection
        title="Escalation workflow"
        summary={workflow.steps.length === 1 ? "1 step" : `${workflow.steps.length} steps`}
        open={workflowOpen}
        disabled={disabled}
        onOpenChange={setWorkflowOpen}
      >
        <ClankerWorkflowForm
          draft={workflow}
          labelPrefix={`${label} workflow`}
          disabled={disabled}
          onChange={(refWorkflow) => onChange({ ...handler, refWorkflow })}
        />
      </NestedSection>
    );
  }
  if (handler.refKind === "step" && handler.refStep !== null) {
    const step = handler.refStep;
    return (
      <ClankerWorkflowStepCard
        step={step}
        labelPrefix={`${label} step`}
        fallbackTitle="Escalation step"
        dependsOnOptions={[]}
        expanded={stepOpen}
        disabled={disabled}
        onExpandedChange={setStepOpen}
        onChange={(refStep) => onChange({ ...handler, refStep })}
      />
    );
  }
  return (
    <p className="text-2xs text-muted-foreground/80">
      No handoff target. The failing step escalates without running anything else.
    </p>
  );
}

function EscalateRow({
  handler,
  index,
  labelPrefix,
  disabled,
  onChange,
  onRemove,
}: {
  readonly handler: ClankerEscalateDraft;
  readonly index: number;
  readonly labelPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerEscalateDraft) => void;
  readonly onRemove: () => void;
}) {
  const label = `${labelPrefix} escalation ${index + 1}`;
  // Each ref shape keeps its own draft, so switching back and forth is lossless.
  const selectRefKind = (refKind: ClankerEscalateRefKind) =>
    onChange({
      ...handler,
      refKind,
      refWorkflow:
        refKind === "workflow" && handler.refWorkflow === null
          ? emptyClankerSubWorkflowDraft()
          : handler.refWorkflow,
      refStep:
        refKind === "step" && handler.refStep === null ? emptyClankerStepDraft() : handler.refStep,
    });

  return (
    <RowShell removeLabel={`Remove ${label.toLowerCase()}`} disabled={disabled} onRemove={onRemove}>
      <div className="grid gap-2 sm:grid-cols-3">
        <FormField label="Handler">
          <EnumSelect
            value={handler.type}
            labels={CLANKER_ESCALATE_TYPE_LABELS}
            ariaLabel={`${label} type`}
            disabled={disabled}
            onChange={(type) => onChange({ ...handler, type })}
          />
        </FormField>
        <FormField label="Model">
          <Input
            size="compact"
            font="mono"
            value={handler.model.id}
            placeholder="gpt-5-codex"
            disabled={disabled}
            aria-label={`${label} model id`}
            onChange={(event) =>
              onChange({ ...handler, model: { ...handler.model, id: event.currentTarget.value } })
            }
          />
        </FormField>
        <FormField label="Provider">
          <Input
            size="compact"
            value={handler.model.provider}
            placeholder="codex"
            disabled={disabled}
            aria-label={`${label} model provider`}
            onChange={(event) =>
              onChange({
                ...handler,
                model: { ...handler.model, provider: event.currentTarget.value },
              })
            }
          />
        </FormField>
      </div>
      <PreservedKeysNote extra={handler.model.extra} />
      <FormField label="Prompt">
        <Textarea
          size="sm"
          value={handler.prompt}
          placeholder="Tell the escalation handler what to decide."
          disabled={disabled}
          aria-label={`${label} prompt`}
          onChange={(event) => onChange({ ...handler, prompt: event.currentTarget.value })}
        />
      </FormField>
      <FormField label="Handoff">
        <div className="w-48">
          <EnumSelect
            value={handler.refKind}
            labels={CLANKER_ESCALATE_REF_LABELS}
            ariaLabel={`${label} handoff`}
            disabled={disabled}
            onChange={selectRefKind}
          />
        </div>
      </FormField>
      <EscalateRefEditor handler={handler} label={label} disabled={disabled} onChange={onChange} />
      <PreservedKeysNote extra={handler.extra} />
    </RowShell>
  );
}

export function QaField({
  qa,
  pathPrefix,
  labelPrefix,
  disabled,
  onChange,
}: {
  readonly qa: ClankerQaDraft;
  readonly pathPrefix: string;
  readonly labelPrefix: string;
  readonly disabled: boolean;
  readonly onChange: (next: ClankerQaDraft) => void;
}) {
  return (
    <SubSection
      title="QA"
      action={
        <Label>
          <Checkbox
            checked={qa.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...qa, enabled: checked })}
          />
          Enabled
        </Label>
      }
    >
      {!qa.enabled ? (
        <p className="text-2xs text-muted-foreground/80">
          No QA block. Enable it to gate the step on checks.
        </p>
      ) : (
        <div className="space-y-2 rounded-lg border border-border/60 p-2">
          <FormField label="On fail">
            <OptionalSelect
              value={qa.onFail}
              labels={CLANKER_QA_ON_FAIL_LABELS}
              unsetLabel="Default (abort)"
              ariaLabel={`${labelPrefix} QA on fail`}
              disabled={disabled}
              onChange={(next) => onChange({ ...qa, onFail: next })}
            />
          </FormField>
          <SubSection
            title="Checks"
            count={qa.checks.length}
            action={
              <AddRowButton
                label="Add check"
                ariaLabel={`Add ${labelPrefix.toLowerCase()} check`}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...qa,
                    checks: [
                      ...qa.checks,
                      emptyClankerQaCheckDraft(nextClankerRowId(`${pathPrefix}/checks`)),
                    ],
                  })
                }
              />
            }
          >
            {qa.checks.length === 0 ? (
              <p className="text-2xs text-muted-foreground/80">No checks.</p>
            ) : (
              <ul className="space-y-1.5">
                {qa.checks.map((check, index) => (
                  <li key={check.rowId}>
                    <QaCheckRow
                      check={check}
                      index={index}
                      labelPrefix={labelPrefix}
                      disabled={disabled}
                      onChange={(next) =>
                        onChange({ ...qa, checks: replaceRow(qa.checks, index, next) })
                      }
                      onRemove={() => onChange({ ...qa, checks: removeRow(qa.checks, index) })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </SubSection>
          <SubSection
            title="Escalation"
            count={qa.escalate.length}
            action={
              <AddRowButton
                label="Add handler"
                ariaLabel={`Add ${labelPrefix.toLowerCase()} escalation handler`}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...qa,
                    escalate: [
                      ...qa.escalate,
                      emptyClankerEscalateDraft(nextClankerRowId(`${pathPrefix}/escalate`)),
                    ],
                  })
                }
              />
            }
          >
            {qa.escalate.length === 0 ? (
              <p className="text-2xs text-muted-foreground/80">
                No escalation handlers. The T3 Code runner reports them as unsupported.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {qa.escalate.map((handler, index) => (
                  <li key={handler.rowId}>
                    <EscalateRow
                      handler={handler}
                      index={index}
                      labelPrefix={labelPrefix}
                      disabled={disabled}
                      onChange={(next) =>
                        onChange({ ...qa, escalate: replaceRow(qa.escalate, index, next) })
                      }
                      onRemove={() => onChange({ ...qa, escalate: removeRow(qa.escalate, index) })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </SubSection>
          <PreservedKeysNote extra={qa.extra} />
        </div>
      )}
    </SubSection>
  );
}

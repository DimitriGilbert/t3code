import type { WatchConnectorInstance, WatchConnectorPackManifest } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";

type ConfigFieldControl = "text" | "number" | "boolean";

interface ConfigField {
  readonly key: string;
  readonly control: ConfigFieldControl;
  readonly required: boolean;
  readonly description?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * The editable fields for one instance: every `authSchema.properties` entry,
 * plus — only when the schema is open (`additionalProperties` not false) —
 * scalar keys already stored in the instance config. Non-scalar values have
 * no scalar editor; they are not listed and pass through the save untouched.
 */
function configFields(
  instance: WatchConnectorInstance,
  manifest: WatchConnectorPackManifest | undefined,
): ReadonlyArray<ConfigField> {
  const authSchema = manifest?.authSchema;
  const properties = asRecord(authSchema?.["properties"]) ?? {};
  const required = new Set(
    (Array.isArray(authSchema?.["required"]) ? authSchema["required"] : []).filter(
      (key): key is string => typeof key === "string",
    ),
  );
  const fields: Array<ConfigField> = [];
  for (const [key, descriptorValue] of Object.entries(properties)) {
    const descriptor = asRecord(descriptorValue);
    const type = asString(descriptor?.["type"]);
    const description = asString(descriptor?.["description"]);
    fields.push({
      key,
      required: required.has(key),
      control:
        type === "boolean"
          ? "boolean"
          : type === "number" || type === "integer"
            ? "number"
            : "text",
      ...(description === undefined ? {} : { description }),
    });
  }
  if (authSchema?.["additionalProperties"] !== false) {
    for (const [key, value] of Object.entries(instance.config)) {
      if (Object.hasOwn(properties, key)) continue;
      const control: ConfigFieldControl | undefined =
        typeof value === "boolean"
          ? "boolean"
          : typeof value === "number"
            ? "number"
            : typeof value === "string"
              ? "text"
              : undefined;
      if (control === undefined) continue;
      fields.push({ key, control, required: false });
    }
  }
  return fields;
}

function initialDraft(
  instance: WatchConnectorInstance,
  fields: ReadonlyArray<ConfigField>,
): Record<string, string | boolean> {
  const draft: Record<string, string | boolean> = {};
  for (const field of fields) {
    const value = instance.config[field.key];
    if (field.control === "boolean") {
      draft[field.key] = value === true;
    } else if (value === undefined || value === null) {
      draft[field.key] = "";
    } else {
      draft[field.key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return draft;
}

/**
 * The generated settings form for one connector instance's `config`, opened
 * from the row menu. Fields come from the pack manifest's `authSchema`
 * (JSON-schema-lite: `properties`/`required`/`additionalProperties`); values
 * are scalars only and secrets are never part of this form — they have their
 * own dialog. Submitting sends the merged config through `setInstanceConfig`,
 * which also restarts the poller.
 */
export function WatchConnectorConfigDialog(props: {
  readonly instance: WatchConnectorInstance;
  readonly manifest: WatchConnectorPackManifest | undefined;
  readonly onSubmit: (config: Record<string, unknown>) => void;
  readonly onClose: () => void;
}) {
  const { instance } = props;
  const fields = configFields(instance, props.manifest);
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    initialDraft(instance, fields),
  );
  const [initial] = useState(() => initialDraft(instance, fields));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const handleSubmit = () => {
    const next: Record<string, unknown> = { ...instance.config };
    for (const field of fields) {
      const raw = draft[field.key];
      if (field.control === "boolean") {
        next[field.key] = raw === true;
        continue;
      }
      const text = String(raw ?? "").trim();
      if (text === "") {
        // Cleared fields drop the key outright — an absent key is the only
        // way "unset" writes, and the server validates required fields.
        delete next[field.key];
        continue;
      }
      if (field.control === "number") {
        const value = Number(text);
        if (Number.isFinite(value)) next[field.key] = value;
        continue;
      }
      // Undeclared keys can carry JSON values; a declared string stays a
      // string even when the text happens to parse.
      const prior = instance.config[field.key];
      if (prior !== undefined && typeof prior !== "string") {
        try {
          next[field.key] = JSON.parse(text);
          continue;
        } catch {
          // Not JSON — fall through and write the raw string.
        }
      }
      next[field.key] = text;
    }
    props.onSubmit(next);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit config</DialogTitle>
          <DialogDescription>
            {instance.name ?? instance.packId} — saving restarts the connector.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {fields.length === 0 ? (
            <p className="text-xs text-muted-foreground">This pack declares no config fields.</p>
          ) : (
            fields.map((field) => {
              const id = `watch-connector-config-${instance.id}-${field.key}`;
              return (
                <div className="grid gap-1" key={field.key}>
                  <Label htmlFor={id}>
                    {field.key}
                    {field.required ? <span className="text-destructive"> *</span> : null}
                  </Label>
                  {field.control === "boolean" ? (
                    <Switch
                      id={id}
                      size="sm"
                      checked={draft[field.key] === true}
                      onCheckedChange={(checked) =>
                        setDraft((current) => ({ ...current, [field.key]: checked === true }))
                      }
                    />
                  ) : (
                    <Input
                      id={id}
                      type={field.control === "number" ? "number" : "text"}
                      inputMode={field.control === "number" ? "numeric" : undefined}
                      value={String(draft[field.key] ?? "")}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                    />
                  )}
                  {field.description === undefined ? null : (
                    <p className="text-2xs text-muted-foreground">{field.description}</p>
                  )}
                </div>
              );
            })
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!dirty || fields.length === 0} onClick={handleSubmit}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

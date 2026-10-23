import type { WatchConnectorInstance } from "@t3tools/contracts";
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

/**
 * Re-enter declared secret values for a connector instance — values never
 * come back from the server (`configuredSecretKeys` reports presence only),
 * so every field starts blank and only filled keys are sent. Config and
 */
export function WatchConnectorSecretDialog(props: {
  readonly instance: WatchConnectorInstance;
  readonly secretKeys: ReadonlyArray<string>;
  readonly onSubmit: (
    secrets: Record<string, string>,
    clearSecretKeys: ReadonlyArray<string>,
  ) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const pending =
    cleared.size > 0 ||
    (props.secretKeys.length > 0 &&
      props.secretKeys.some((key) => (values[key] ?? "").trim() !== ""));
  const toggleClear = (key: string) =>
    setCleared((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Update secrets</DialogTitle>
          <DialogDescription>
            {props.instance.name ?? props.instance.packId}, stored on the server, never shown here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.secretKeys.map((key) => {
            const configured = props.instance.configuredSecretKeys.includes(key);
            const markedForClear = cleared.has(key);
            return (
              <div className="grid gap-1" key={key}>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`watch-secret-${props.instance.id}-${key}`}>
                    {key}
                    {configured ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {markedForClear
                          ? "(set; will be removed)"
                          : "(set; enter a new value to replace)"}
                      </span>
                    ) : null}
                  </Label>
                  {configured ? (
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="xs"
                      aria-label={
                        markedForClear ? `Keep stored secret ${key}` : `Clear stored secret ${key}`
                      }
                      onClick={() => toggleClear(key)}
                    >
                      {markedForClear ? "Undo" : "Clear"}
                    </Button>
                  ) : null}
                </div>
                <Input
                  id={`watch-secret-${props.instance.id}-${key}`}
                  type="password"
                  autoComplete="off"
                  disabled={markedForClear}
                  value={values[key] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
              </div>
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!pending}
            onClick={() => {
              const secrets: Record<string, string> = {};
              for (const [key, value] of Object.entries(values)) {
                const trimmed = value.trim();
                if (trimmed !== "" && !cleared.has(key)) secrets[key] = trimmed;
              }
              // Only keys that still have a stored value can be cleared — a
              // key revoked elsewhere while this dialog was open drops out
              // instead of failing the write.
              const clearSecretKeys = props.secretKeys.filter(
                (key) => cleared.has(key) && props.instance.configuredSecretKeys.includes(key),
              );
              props.onSubmit(secrets, clearSecretKeys);
            }}
          >
            Save secrets
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

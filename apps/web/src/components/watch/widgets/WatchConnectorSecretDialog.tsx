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
 * secrets stay separate at the wire level too: this dialog only produces the
 * `secrets` record for `setInstanceConfig`.
 */
export function WatchConnectorSecretDialog(props: {
  readonly instance: WatchConnectorInstance;
  readonly secretKeys: ReadonlyArray<string>;
  readonly onSubmit: (secrets: Record<string, string>) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const pending =
    props.secretKeys.length > 0 &&
    props.secretKeys.some((key) => (values[key] ?? "").trim() !== "");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Update secrets</DialogTitle>
          <DialogDescription>
            {props.instance.name ?? props.instance.packId} — stored on the server, never shown here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.secretKeys.map((key) => (
            <div className="grid gap-1" key={key}>
              <Label htmlFor={`watch-secret-${props.instance.id}-${key}`}>
                {key}
                {props.instance.configuredSecretKeys.includes(key) ? (
                  <span className="text-muted-foreground">
                    {" "}
                    (set — enter a new value to replace)
                  </span>
                ) : null}
              </Label>
              <Input
                id={`watch-secret-${props.instance.id}-${key}`}
                type="password"
                autoComplete="off"
                value={values[key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [key]: event.target.value }))
                }
              />
            </div>
          ))}
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
                if (trimmed !== "") secrets[key] = trimmed;
              }
              props.onSubmit(secrets);
            }}
          >
            Save secrets
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

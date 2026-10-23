import type { ClankerWorkflowPath, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { clankerEnvironment } from "~/state/clanker";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { clankerWorkflowNameError, clankerWorkflowSlug } from "./clankerView";

export function NewClankerWorkflowDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onCreated: (path: ClankerWorkflowPath) => void;
}) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const createWorkflow = useAtomCommand(clankerEnvironment.createWorkflow, {
    label: "clanker workflow create",
    reportFailure: false,
  });

  const nameError = clankerWorkflowNameError(name);
  const slug = clankerWorkflowSlug(name);

  const create = async () => {
    setTouched(true);
    if (creating || nameError !== null) return;
    setCreating(true);
    const result = await createWorkflow({ environmentId, input: { projectId, name } });
    setCreating(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create workflow",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    setName("");
    setTouched(false);
    onOpenChange(false);
    onCreated(result.value.path);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setTouched(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New clanker workflow</DialogTitle>
          <DialogDescription>
            Creates a YAML file in <span className="font-mono">.clanker/workflows</span> on this
            project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label htmlFor="clanker-workflow-name">Name</Label>
            <Input
              id="clanker-workflow-name"
              size="sm"
              value={name}
              placeholder="deploy-preview"
              aria-invalid={touched && nameError !== null}
              onChange={(event) => {
                setName(event.currentTarget.value);
                if (!touched) setTouched(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
              }}
            />
            {touched && nameError !== null ? (
              <p className="text-xs text-destructive">{nameError}</p>
            ) : slug.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Saved as <span className="font-mono">{slug}.yaml</span> (or{" "}
                <span className="font-mono">{slug}-N.yaml</span> if the name is taken)
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={creating} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={creating || nameError !== null} onClick={() => void create()}>
            {creating ? "Creating…" : "Create workflow"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import type { ClankerRunStatus, ClankerStepStatus } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  CircleXIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { CLANKER_RUN_STATUS_LABEL, CLANKER_STEP_STATUS_LABEL } from "./clankerRunView";

const RUN_BADGE_VARIANT = {
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "outline",
} as const satisfies Record<ClankerRunStatus, "info" | "success" | "error" | "outline">;

export function ClankerRunStatusBadge({ status }: { readonly status: ClankerRunStatus }) {
  return (
    <Badge variant={RUN_BADGE_VARIANT[status]}>
      {status === "running" ? (
        <Spinner size="xs" />
      ) : status === "completed" ? (
        <CircleCheckIcon aria-hidden />
      ) : status === "failed" ? (
        <CircleXIcon aria-hidden />
      ) : (
        <CircleSlashIcon aria-hidden />
      )}
      {CLANKER_RUN_STATUS_LABEL[status]}
    </Badge>
  );
}

const STEP_ICON_CLASS: Record<ClankerStepStatus, string> = {
  pending: "text-muted-foreground/50",
  running: "text-info",
  passed: "text-success",
  failed: "text-destructive",
  skipped: "text-muted-foreground/70",
};

export function ClankerStepStatusIcon({
  status,
  className,
}: {
  readonly status: ClankerStepStatus;
  readonly className?: string;
}) {
  const label = CLANKER_STEP_STATUS_LABEL[status];
  if (status === "running") {
    return (
      <span className={cn("flex shrink-0", STEP_ICON_CLASS.running, className)}>
        <Spinner size="md" aria-label={label} />
      </span>
    );
  }
  const shared = cn("size-4 shrink-0", STEP_ICON_CLASS[status], className);
  const Icon =
    status === "passed"
      ? CircleCheckIcon
      : status === "failed"
        ? CircleXIcon
        : status === "skipped"
          ? CircleMinusIcon
          : CircleDashedIcon;
  return <Icon aria-label={label} role="img" className={shared} />;
}

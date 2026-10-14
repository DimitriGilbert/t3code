import {
  watchWidgetErrorPresentation,
  type WatchWidgetErrorActionId,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { WatchWidgetErrorState } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  FileWarningIcon,
  FolderSearchIcon,
  KeyRoundIcon,
  PackageXIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { formatShortTimestamp } from "~/timestampFormat";
import { cn } from "~/lib/utils";

const ERROR_ICONS: Record<WatchWidgetErrorState["cause"], typeof TriangleAlertIcon> = {
  connectorDown: UnplugIcon,
  credentialsInvalid: KeyRoundIcon,
  configMismatch: TriangleAlertIcon,
  connectorMissing: PackageXIcon,
  connectorSnapshotTooLarge: TriangleAlertIcon,
  projectMissing: FolderSearchIcon,
  transpileFailed: FileWarningIcon,
};

function formatLastGood(iso: string, timestampFormat: TimestampFormat): string {
  const time = formatShortTimestamp(iso, timestampFormat);
  return `Last good data at ${time}`;
}

/**
 * The typed degradation every watch widget renders inside its content
 * region: icon, one-line cause, last-good timestamp when known, and the
 * cause's recovery actions. `compact` is the stale-data variant — a slim
 * strip that sits above still-usable data instead of swapping it out.
 */
export function WatchWidgetErrorBody(props: {
  readonly error: WatchWidgetErrorState;
  readonly timestampFormat: TimestampFormat;
  /** Slim warning strip over live data; full card body when false. */
  readonly compact?: boolean;
  /** Dispatches a presented action id; absent = no action buttons. */
  readonly onAction?: ((action: WatchWidgetErrorActionId) => void) | undefined;
  /** Action ids the host cannot perform — their buttons are never rendered. */
  readonly hiddenActions?: ReadonlyArray<WatchWidgetErrorActionId> | undefined;
}) {
  const presentation = watchWidgetErrorPresentation(props.error);
  const Icon = ERROR_ICONS[props.error.cause];
  const onAction = props.onAction;
  const hidden = props.hiddenActions ?? [];
  const visible = (id: WatchWidgetErrorActionId) => !hidden.includes(id);

  const action = presentation.action;
  const actionButton =
    onAction === undefined || action === undefined || !visible(action.id) ? null : (
      <Button size="xs" variant={action.button} onClick={() => onAction(action.id)}>
        {action.label}
      </Button>
    );
  const secondaryAction = presentation.secondaryAction;
  const secondaryButton =
    onAction === undefined ||
    secondaryAction === undefined ||
    !visible(secondaryAction.id) ? null : (
      <Button size="xs" variant="ghost" onClick={() => onAction(secondaryAction.id)}>
        {secondaryAction.label}
      </Button>
    );

  if (props.compact === true) {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
          presentation.variant === "error"
            ? "border-error/32 bg-error-surface text-error-foreground"
            : presentation.variant === "warning"
              ? "border-warning/32 bg-warning-surface text-warning-foreground"
              : "border-border/60 text-muted-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{presentation.line}</span>
        {actionButton}
        {secondaryButton}
      </div>
    );
  }

  return (
    <Alert variant={presentation.variant} className="m-2">
      <Icon className="size-4" aria-hidden />
      <AlertTitle>{presentation.line}</AlertTitle>
      <AlertDescription>
        {props.error.lastGoodDataAt === undefined ? null : (
          <span className="block truncate">
            {formatLastGood(props.error.lastGoodDataAt, props.timestampFormat)}
          </span>
        )}
      </AlertDescription>
      {actionButton === null && secondaryButton === null ? null : (
        <AlertAction>
          {actionButton}
          {secondaryButton}
        </AlertAction>
      )}
    </Alert>
  );
}

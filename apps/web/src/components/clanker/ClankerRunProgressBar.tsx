const TONE_CLASS = {
  default: "bg-primary",
  failed: "bg-destructive",
  done: "bg-success",
} as const;

/**
 * Settled-step progress. Width is a style because the value is continuous;
 * there is no transition, so a run that advances every few seconds does not
 * keep the compositor busy.
 */
export function ClankerRunProgressBar({
  percent,
  tone = "default",
}: {
  readonly percent: number;
  readonly tone?: keyof typeof TONE_CLASS;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-1 w-full overflow-hidden rounded-full bg-border/70"
    >
      <div className={`h-full rounded-full ${TONE_CLASS[tone]}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

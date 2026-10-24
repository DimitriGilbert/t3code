import { useNowSecond } from "~/hooks/useNowSecond";

import { formatClankerDuration, type ClankerDurationRange } from "./clankerRunView";

// Kept as its own leaf so the shared second tick re-renders the label alone,
// not the run card it sits in.
function LiveDuration({ startedMs }: { readonly startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatClankerDuration(Math.max(0, nowMs - startedMs))}</span>
  );
}

export function ClankerDuration({ range }: { readonly range: ClankerDurationRange | null }) {
  if (range === null) return null;
  const startedMs = Date.parse(range.startedAt);
  if (Number.isNaN(startedMs)) return null;
  if (range.endedAt === null) return <LiveDuration startedMs={startedMs} />;
  const endedMs = Date.parse(range.endedAt);
  if (Number.isNaN(endedMs)) return null;
  return (
    <span className="tabular-nums">{formatClankerDuration(Math.max(0, endedMs - startedMs))}</span>
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { ClankerPage, type ClankerSearch } from "../components/clanker/ClankerPage";

export const Route = createFileRoute("/_chat/clanker")({
  validateSearch: (raw: Record<string, unknown>): ClankerSearch => ({
    ...(typeof raw.project === "string" && raw.project ? { project: raw.project } : {}),
    ...(typeof raw.file === "string" && raw.file.trim() ? { file: raw.file } : {}),
    ...(raw.tab === "runs" ? { tab: "runs" as const } : {}),
    ...(typeof raw.run === "string" && raw.run.trim() ? { run: raw.run } : {}),
  }),
  component: ClankerPage,
});

import type { EnvironmentId } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ClankerProjectOption } from "./clankerView";

/**
 * Project switcher shared by the workflow and run lists. With a single project
 * there is nothing to pick, so it degrades to the project's name.
 */
export function ClankerProjectSelect({
  options,
  selected,
  environmentLabel,
  size = "compact",
  onSelectProject,
}: {
  readonly options: ReadonlyArray<ClankerProjectOption>;
  readonly selected: ClankerProjectOption | null;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly size?: "compact" | "default";
  readonly onSelectProject: (key: string) => void;
}) {
  if (options.length <= 1) {
    return selected === null ? null : (
      <span className="truncate text-sm text-muted-foreground">{selected.label}</span>
    );
  }
  return (
    <Select
      value={selected?.key ?? ""}
      onValueChange={(key) => {
        if (key !== null) onSelectProject(key);
      }}
    >
      <SelectTrigger size={size} aria-label="Project">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{selected?.label ?? "Project"}</span>
            {selected !== null && environmentLabel(selected.environmentId) !== null ? (
              <span className="truncate text-muted-foreground">
                {environmentLabel(selected.environmentId)}
              </span>
            ) : null}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.key} value={option.key} label={option.label}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{option.label}</span>
              {environmentLabel(option.environmentId) !== null ? (
                <span className="truncate text-xs text-muted-foreground">
                  {environmentLabel(option.environmentId)}
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

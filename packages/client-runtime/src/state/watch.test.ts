import { WatchPageId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { isWatchPageRevisionConflict } from "./watch.ts";

// Journey 1's conflict leg ends here: a revision-checked write that loses to
// another client's commit surfaces as this tagged value, and only that value
// flags the page for reload. The squashed cause of a failed RPC is a tagged
// value, not a decoded class instance, so the predicate is structural.
describe("isWatchPageRevisionConflict", () => {
  it("matches a tagged conflict value with a page id", () => {
    expect(
      isWatchPageRevisionConflict({
        _tag: "WatchPageRevisionConflictError",
        pageId: WatchPageId.make("watch-page:home"),
      }),
    ).toBe(true);
  });

  it("rejects errors that are not the page revision conflict", () => {
    expect(isWatchPageRevisionConflict(new Error("boom"))).toBe(false);
    expect(isWatchPageRevisionConflict({ _tag: "WatchConnectorError" })).toBe(false);
    expect(isWatchPageRevisionConflict("WatchPageRevisionConflictError")).toBe(false);
    expect(isWatchPageRevisionConflict(null)).toBe(false);
    expect(isWatchPageRevisionConflict(undefined)).toBe(false);
  });
});

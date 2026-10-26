import {
  WatchLayoutCollisionError,
  WatchPageId,
  WatchPageRevisionConflictError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));

import { reportWatchWriteResult, settleWatchWidgetConfigure } from "./WatchScreen";

const pageId = WatchPageId.make("watch-page:p1");

const conflictResult = () =>
  AsyncResult.failure(
    Cause.fail(
      new WatchPageRevisionConflictError({
        pageId,
        expectedRevision: 3,
        message: "The page changed since you loaded it.",
      }),
    ),
  );

const collisionResult = () =>
  AsyncResult.failure(
    Cause.fail(
      new WatchLayoutCollisionError({
        pageId,
        widgetIds: [],
        message: "Widgets cannot overlap.",
      }),
    ),
  );

const flush = () => Promise.resolve();

afterEach(() => {
  state.toast.mockReset();
});

describe("reportWatchWriteResult", () => {
  it("keeps the dedicated warning toast for a revision conflict", () => {
    reportWatchWriteResult(conflictResult());
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  });

  it("surfaces a non-conflict write failure as an error toast", () => {
    reportWatchWriteResult(collisionResult());
    expect(state.toast).toHaveBeenCalledTimes(1);
    const toast = state.toast.mock.calls[0]![0] as { type: string; description?: string };
    expect(toast.type).toBe("error");
    expect(toast.description).toBe("Widgets cannot overlap.");
  });

  it("toasts transport-level failures too", () => {
    reportWatchWriteResult(AsyncResult.failure(Cause.fail(new Error("socket closed"))));
    const toast = state.toast.mock.calls[0]![0] as { type: string; description?: string };
    expect(toast.type).toBe("error");
    expect(toast.description).toBe("socket closed");
  });

  it("stays silent on success", () => {
    reportWatchWriteResult(AsyncResult.success(undefined));
    expect(state.toast).not.toHaveBeenCalled();
  });
});

describe("settleWatchWidgetConfigure", () => {
  it("closes the form only once the write lands", async () => {
    const onClose = vi.fn();
    settleWatchWidgetConfigure(Promise.resolve(AsyncResult.success(undefined)), onClose);
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("keeps the draft mounted on a revision conflict", async () => {
    const onClose = vi.fn();
    settleWatchWidgetConfigure(Promise.resolve(conflictResult()), onClose);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  });

  it("keeps the draft mounted on other failures", async () => {
    const onClose = vi.fn();
    settleWatchWidgetConfigure(Promise.resolve(collisionResult()), onClose);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});

import {
  WatchConnectorInstanceId,
  WatchConnectorPackId,
  type WatchConnectorInstance,
} from "@t3tools/contracts";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  submit: vi.fn(),
  close: vi.fn(),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
  DialogPopup: ({ children }: { children?: ReactNode }) => children,
  DialogHeader: ({ children }: { children?: ReactNode }) => children,
  DialogPanel: ({ children }: { children?: ReactNode }) => children,
  DialogFooter: ({ children }: { children?: ReactNode }) => children,
  DialogTitle: ({ children }: { children?: ReactNode }) => children,
  DialogDescription: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ render: _render, ...props }: { render?: ReactElement } & Record<string, unknown>) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("~/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("~/components/ui/label", () => ({
  Label: (props: Record<string, unknown>) => <label {...props} />,
}));

import { WatchConnectorSecretDialog } from "./WatchConnectorSecretDialog";

const nowIso = "2026-06-20T12:00:00.000Z";

const instance: WatchConnectorInstance = {
  id: WatchConnectorInstanceId.make("inst-1"),
  packId: WatchConnectorPackId.make("pack-1"),
  schemaVersion: 1,
  config: {},
  configuredSecretKeys: ["API_KEY"],
  origin: { kind: "httpsUrl", url: "https://example.com/pack" },
  contentHash: "abc123",
  health: { status: "healthy", lastError: null, lastFetchAt: null, consecutiveFailures: 0 },
  archivedAt: null,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const collectText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join(" ");
  if (isValidElement(value)) {
    return collectText((value.props as { children?: ReactNode }).children);
  }
  if (value !== null && typeof value === "object" && "children" in value) {
    return collectText((value as { children?: ReactNode }).children);
  }
  return "";
};

let renderer: ReactTestRenderer | undefined;

const renderDialog = (secretKeys: ReadonlyArray<string> = ["API_KEY", "OTHER_KEY"]) =>
  act(async () => {
    renderer = create(
      <WatchConnectorSecretDialog
        instance={instance}
        secretKeys={secretKeys}
        onSubmit={state.submit}
        onClose={state.close}
      />,
    );
    await Promise.resolve();
  });

const findButton = (label: string) =>
  renderer?.root
    .findAllByType("button")
    .find(
      (button) =>
        collectText(button.props.children).includes(label) ||
        (typeof button.props["aria-label"] === "string" &&
          button.props["aria-label"].includes(label)),
    );

const findInput = (key: string) =>
  renderer?.root
    .findAllByType("input")
    .find((input) => input.props.id === `watch-secret-${instance.id}-${key}`);

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.submit.mockReset();
  state.close.mockReset();
});

describe("WatchConnectorSecretDialog", () => {
  it("marks a configured key for clearing and submits it via clearSecretKeys", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await renderDialog();

    // Nothing to submit yet.
    expect(findButton("Save secrets")?.props.disabled).toBe(true);

    const clearButton = findButton("Clear stored secret API_KEY");
    expect(clearButton).toBeDefined();
    // Only configured keys get a clear affordance.
    expect(findButton("Clear stored secret OTHER_KEY")).toBeUndefined();

    act(() => {
      clearButton?.props.onClick();
    });
    expect(findInput("API_KEY")?.props.disabled).toBe(true);
    expect(findButton("Save secrets")?.props.disabled).toBe(false);

    act(() => {
      findButton("Save secrets")?.props.onClick();
    });
    expect(state.submit).toHaveBeenCalledWith({}, ["API_KEY"]);
  });

  it("sends a stored-value clear together with replacement values for other keys", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await renderDialog();

    act(() => {
      findButton("Clear stored secret API_KEY")?.props.onClick();
    });
    act(() => {
      findInput("OTHER_KEY")?.props.onChange({ target: { value: "  new-secret  " } });
    });
    act(() => {
      findButton("Save secrets")?.props.onClick();
    });

    expect(state.submit).toHaveBeenCalledWith({ OTHER_KEY: "new-secret" }, ["API_KEY"]);
  });

  it("undoing a clear restores the input and sends the replacement instead", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await renderDialog();

    act(() => {
      findButton("Clear stored secret API_KEY")?.props.onClick();
    });
    act(() => {
      findButton("Keep stored secret API_KEY")?.props.onClick();
    });
    expect(findInput("API_KEY")?.props.disabled).toBe(false);

    act(() => {
      findInput("API_KEY")?.props.onChange({ target: { value: "rotated" } });
    });
    act(() => {
      findButton("Save secrets")?.props.onClick();
    });

    expect(state.submit).toHaveBeenCalledWith({ API_KEY: "rotated" }, []);
  });
});

import {
  EnvironmentId,
  WatchConnectorInstallRequestId,
  WatchConnectorPackId,
  type WatchConnectorInstallRequest,
  type WatchConnectorPack,
  type WatchConnectorPackManifest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  canConfirm: true,
  toast: vi.fn(),
}));

vi.mock("~/state/watch", () => ({
  watchEnvironment: {
    prepareConnectorInstallConfirm: { label: "prepare", permissionAtom: () => null },
    confirmConnectorInstall: { label: "confirm-install", permissionAtom: () => null },
    confirmConnectorUpgrade: { label: "confirm-upgrade", permissionAtom: () => null },
    cancelConnectorInstallRequest: { label: "cancel", permissionAtom: () => null },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    switch (command.label) {
      case "prepare":
        return state.prepare;
      case "confirm-install":
      case "confirm-upgrade":
        return state.confirm;
      case "cancel":
        return state.cancel;
      default:
        return vi.fn();
    }
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.canConfirm,
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
  DialogPopup: ({ children }: { children?: ReactNode }) => children,
  DialogHeader: ({ children }: { children?: ReactNode }) => children,
  DialogPanel: ({ children }: { children?: ReactNode }) => children,
  DialogFooter: ({ children }: { children?: ReactNode }) => children,
  DialogTitle: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    children === undefined ? render : cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/checkbox", () => ({
  Checkbox: (props: {
    readonly checked?: boolean;
    readonly onCheckedChange?: (checked: boolean | "indeterminate") => void;
  }) => <input data-slot="checkbox" type="checkbox" checked={props.checked ?? false} readOnly />,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ render: _render, ...props }: { render?: ReactElement } & Record<string, unknown>) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("~/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span data-slot="badge">{children}</span>,
}));
vi.mock("~/components/ui/skeleton", () => ({ Skeleton: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/components/ui/anchoredCopyToast", () => ({
  ANCHORED_COPY_TOAST_TIMEOUT_MS: 1000,
  showAnchoredCopyErrorToast: vi.fn(),
  showAnchoredCopySuccessToast: vi.fn(),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));

import { Checkbox } from "~/components/ui/checkbox";
import { WatchConnectorInstallConfirmDialog } from "./WatchConnectorInstallConfirmDialog";

const environmentId = EnvironmentId.make("env-1");
const packId = WatchConnectorPackId.make("pack:acme");

const manifest: WatchConnectorPackManifest = {
  id: packId,
  schemaVersion: 1,
  operations: [{ name: "poll", description: "Poll the upstream" }, { name: "ack" }],
  egressHosts: ["api.acme.test"],
  secretKeys: ["ACME_TOKEN"],
  transport: "http",
  widgets: [
    {
      name: "status",
      file: "widgets/status.tsx",
      bridge: { subscriptions: ["snapshot"], actions: ["refresh"] },
    },
  ],
};

const installRequest: WatchConnectorInstallRequest = {
  id: WatchConnectorInstallRequestId.make("request-1"),
  kind: "install",
  status: "pending",
  packId,
  origin: { kind: "httpsUrl", url: "https://packs.acme.test/acme.tgz" },
  contentHash: "sha256:abc123",
  manifest,
  localUrl: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const localRequest: WatchConnectorInstallRequest = {
  ...installRequest,
  id: WatchConnectorInstallRequestId.make("request-local"),
  packId: null,
  contentHash: null,
  manifest: null,
  localUrl: true,
};

const fetchedRequest: WatchConnectorInstallRequest = {
  ...localRequest,
  packId,
  contentHash: "sha256:abc123",
  manifest,
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

const renderDialog = (request: WatchConnectorInstallRequest | null) =>
  act(async () => {
    renderer = create(
      <WatchConnectorInstallConfirmDialog
        environmentId={environmentId}
        request={request}
        onClose={vi.fn()}
      />,
    );
    await Promise.resolve();
  });

const dialogText = () => collectText(renderer?.toJSON());
const findButton = (label: string) =>
  renderer?.root
    .findAllByType("button")
    .find((button) => collectText(button.props.children).includes(label));
const checkbox = () => renderer?.root.findByType(Checkbox);

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  state.canConfirm = true;
  state.prepare.mockReset();
  state.confirm.mockReset();
  state.cancel.mockReset();
  state.toast.mockClear();
});

describe("WatchConnectorInstallConfirmDialog", () => {
  it("lists declared operations and bundled widgets on the install leg", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.prepare.mockResolvedValue(
      AsyncResult.success({ request: installRequest, diffBase: null, confirmationToken: "t-1" }),
    );

    await renderDialog(installRequest);

    const text = dialogText();
    expect(text).toContain("Operations it exposes");
    expect(text).toContain("poll");
    expect(text).toContain("Poll the upstream");
    expect(text).toContain("ack");
    expect(text).toContain("Bundled widgets");
    expect(text).toContain("status");
    expect(text).toContain("reads snapshot · actions refresh");
  });

  it("renders widget, bridge, authSchema, and description rows on the upgrade leg", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const nextManifest: WatchConnectorPackManifest = {
      ...manifest,
      schemaVersion: 2,
      authSchema: { region: { type: "string" } },
      operations: [{ name: "poll", description: "Poll upstream metrics" }, { name: "ack" }],
      widgets: [
        {
          name: "status",
          file: "widgets/status-v2.tsx",
          bridge: { subscriptions: ["snapshot", "events"], actions: ["refresh"] },
        },
        {
          name: "alerts",
          file: "widgets/alerts.tsx",
          bridge: { subscriptions: [], actions: [] },
        },
      ],
    };
    const upgradeRequest: WatchConnectorInstallRequest = {
      ...installRequest,
      id: WatchConnectorInstallRequestId.make("request-upgrade"),
      kind: "upgrade",
      manifest: nextManifest,
      upgrade: { fromSchemaVersion: 1 },
    };
    const diffBase: WatchConnectorPack = {
      packId,
      schemaVersion: 1,
      manifest,
      origin: installRequest.origin,
      contentHash: "sha256:abc123",
      approvedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    state.prepare.mockResolvedValue(
      AsyncResult.success({ request: upgradeRequest, diffBase, confirmationToken: "t-2" }),
    );

    await renderDialog(upgradeRequest);

    const text = dialogText();
    expect(text).toContain("schemaVersion 1 → 2");
    expect(text).toContain("widget alerts");
    expect(text).toContain("widget status file widgets/status.tsx → widgets/status-v2.tsx");
    expect(text).toContain("widget status subscription events");
    expect(text).toContain("operation poll description");
    expect(text).toContain("authSchema changed");
  });

  it("requires a fresh review ack after the deferred localUrl fetch lands", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.prepare.mockResolvedValue(
      AsyncResult.success({ request: fetchedRequest, diffBase: null, confirmationToken: "t-3" }),
    );

    await renderDialog(localRequest);

    // Nothing fetched until the fetch ack — no auto-prepare, no confirm button.
    expect(state.prepare).not.toHaveBeenCalled();
    expect(findButton("Confirm install")).toBeUndefined();
    expect(findButton("Fetch and review")?.props.disabled).toBe(true);

    act(() => {
      checkbox()?.props.onCheckedChange(true);
    });
    expect(findButton("Fetch and review")?.props.disabled).toBe(false);

    await act(async () => {
      findButton("Fetch and review")?.props.onClick();
      await Promise.resolve();
    });
    expect(state.prepare).toHaveBeenCalledWith({
      environmentId,
      input: { requestId: localRequest.id, allowLocalUrl: true },
    });

    // The fetch ack covered fetching the URL — it must not satisfy the
    // post-fetch "I reviewed what this pack can reach" acknowledgement.
    expect(findButton("Fetch and review")).toBeUndefined();
    expect(checkbox()?.props.checked).toBe(false);
    expect(findButton("Confirm install")?.props.disabled).toBe(true);
    expect(state.prepare).toHaveBeenCalledTimes(1);

    act(() => {
      checkbox()?.props.onCheckedChange(true);
    });
    expect(findButton("Confirm install")?.props.disabled).toBe(false);
  });
});

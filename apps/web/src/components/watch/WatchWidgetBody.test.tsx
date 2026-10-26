import {
  EnvironmentId,
  WatchPageId,
  WatchWidgetId,
  type WatchPage,
  type WatchWidget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The configure path under test never reaches the sandboxed app frame, but
// WatchWidgetBody imports it — keep its atom dependency inert.
vi.mock("~/state/watch", () => ({
  watchEnvironment: {
    widgetSourceLive: vi.fn(),
    getWidgetSource: {},
  },
}));
// The base-ui control wrappers merge event handlers that demand real DOM
// events; the draft logic under test lives in the form, so the primitives
// render as plain host elements.
vi.mock("~/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("~/components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));
vi.mock("~/components/ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => (
    <input type="checkbox" checked={props.checked === true} readOnly />
  ),
}));

import { WatchWidgetBody } from "./WatchWidgetBody";
import { act } from "../../../test/act";

const environmentId = Schema.decodeSync(EnvironmentId)("env-1");

const page: WatchPage = {
  id: WatchPageId.make("watch-page:p1"),
  name: "Page",
  scope: "global",
  projectId: null,
  orderKey: "a0",
  revision: 0,
  mobileRevision: 0,
  archivedAt: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const makeWidget = (revision: number, maxItems: number): WatchWidget => ({
  id: WatchWidgetId.make("watch-widget:w1"),
  pageId: page.id,
  kind: "active-work",
  config: { settings: { maxItems } },
  placement: { x: 0, y: 0, w: 4, h: 2 },
  revision,
  mobileOrder: 0,
  mobileHidden: false,
  provenance: "firstParty",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const body = (widget: WatchWidget) => (
  <WatchWidgetBody
    environmentId={environmentId}
    page={page}
    widget={widget}
    projects={[]}
    threads={[]}
    providers={[]}
    snoozeSupported={false}
    timestampFormat="locale"
    connectorInstances={[]}
    connectorPacks={[]}
    packWidgetSources={[]}
    connectorsReady
    connectorsError={null}
    configuring
    onConfigureSubmit={() => undefined}
    onConfigureClose={() => undefined}
    onReconnectConnector={() => undefined}
    onUpdateConnectorSecret={() => undefined}
    installRequests={[]}
    onReviewInstallRequest={() => undefined}
    onOpenThread={() => undefined}
  />
);

const maxItemsInput = () => {
  const input = renderer!.root.findAllByType("input").find((node) => node.props.type === "number");
  if (input === undefined) throw new Error("maxItems input not rendered");
  return input;
};

describe("WatchWidgetBody configure form", () => {
  it("re-bases the draft when a remote write bumps the widget revision", async () => {
    await act(async () => {
      renderer = create(body(makeWidget(0, 5)));
    });
    expect(maxItemsInput().props.value).toBe("5");

    // An in-progress local edit.
    await act(async () => {
      maxItemsInput().props.onChange({ target: { value: "9" } });
    });
    expect(maxItemsInput().props.value).toBe("9");

    // Another client wrote a different config — the live subscription
    // delivers a bumped revision and the form must not keep submitting the
    // stale draft under the fresh revision.
    await act(async () => {
      renderer!.update(body(makeWidget(1, 7)));
    });
    expect(maxItemsInput().props.value).toBe("7");

    // The remount discarded the draft silently — the gate says why.
    const serialized = JSON.stringify(renderer!.toJSON());
    expect(serialized).toContain("changed on another client");
  });

  it("keeps the draft across updates that do not change the revision", async () => {
    await act(async () => {
      renderer = create(body(makeWidget(0, 5)));
    });
    await act(async () => {
      maxItemsInput().props.onChange({ target: { value: "9" } });
    });

    // A non-config update (e.g. refreshed updatedAt) must not remount.
    await act(() => {
      renderer!.update(body({ ...makeWidget(0, 5), updatedAt: "2025-01-02T00:00:00.000Z" }));
    });
    expect(maxItemsInput().props.value).toBe("9");
    const serialized = JSON.stringify(renderer!.toJSON());
    expect(serialized).not.toContain("changed on another client");
  });
});

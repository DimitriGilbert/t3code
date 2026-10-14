import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, WatchPageId, WatchWidgetId } from "@t3tools/contracts";
import type { ServerConfig, WatchWidget } from "@t3tools/contracts";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  resolveWatchEntryEnvironmentId,
  watchAgentWidgetsMobileSupported,
  watchMobileVisibleWidgets,
  watchScreenSupported,
} from "./watchMobile";

const config = (overrides: Partial<ServerConfig> = {}): ServerConfig =>
  overrides as unknown as ServerConfig;

const environmentId = (id: string) => EnvironmentId.make(`env:${id}`);

const environment = (id: string, isEnabled = true): WorkspaceEnvironment => ({
  environmentId: environmentId(id),
  environmentLabel: id,
  displayUrl: "",
  isRelayManaged: false,
  isEnabled,
  connectionState: "connected",
  connectionError: null,
  connectionErrorTraceId: null,
});

const widget = (id: string, kind: string, mobileHidden = false): WatchWidget => ({
  id: WatchWidgetId.make(`watch-widget:${id}`),
  pageId: WatchPageId.make("watch-page:p"),
  kind,
  config: {},
  placement: { x: 0, y: 0, w: 4, h: 2 },
  revision: 1,
  mobileOrder: 0,
  mobileHidden,
  provenance: kind.startsWith("agent:") ? "agentPublished" : "firstParty",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

describe("watchScreenSupported", () => {
  it("requires an explicit true — absent, false, and missing config all hide the screen", () => {
    expect(watchScreenSupported(config({ watchScreen: true }))).toBe(true);
    expect(watchScreenSupported(config({ watchScreen: false }))).toBe(false);
    expect(watchScreenSupported(config({}))).toBe(false);
    expect(watchScreenSupported(null)).toBe(false);
    expect(watchScreenSupported(undefined)).toBe(false);
  });
});

describe("watchAgentWidgetsMobileSupported", () => {
  it("requires an explicit true — the sandbox kill switch defaults off", () => {
    expect(watchAgentWidgetsMobileSupported(config({ watchAgentWidgetsMobile: true }))).toBe(true);
    expect(watchAgentWidgetsMobileSupported(config({ watchAgentWidgetsMobile: false }))).toBe(
      false,
    );
    expect(watchAgentWidgetsMobileSupported(config({ watchScreen: true }))).toBe(false);
    expect(watchAgentWidgetsMobileSupported(null)).toBe(false);
  });
});

describe("watchMobileVisibleWidgets", () => {
  const widgets = [
    widget("a", "active-work"),
    widget("b", "agent:source-1"),
    widget("c", "task-starter"),
  ];

  it("drops every agent widget when the capability is off", () => {
    expect(watchMobileVisibleWidgets(widgets, false).map((w) => w.id)).toEqual([
      WatchWidgetId.make("watch-widget:a"),
      WatchWidgetId.make("watch-widget:c"),
    ]);
  });

  it("keeps the full stack when the capability is on", () => {
    expect(watchMobileVisibleWidgets(widgets, true)).toHaveLength(3);
  });
});

describe("resolveWatchEntryEnvironmentId", () => {
  it("returns null — entry point hidden — when no enabled environment advertises the capability", () => {
    const environments = [environment("one"), environment("two")];
    const serverConfigs = new Map([
      [environmentId("one"), config({})],
      [environmentId("two"), config({ watchScreen: false })],
    ]);
    expect(resolveWatchEntryEnvironmentId({ environments, serverConfigs })).toBeNull();
    expect(resolveWatchEntryEnvironmentId({ environments, serverConfigs: new Map() })).toBeNull();
  });

  it("opens the filtered environment when it supports the screen", () => {
    const environments = [environment("one"), environment("two")];
    const serverConfigs = new Map([
      [environmentId("one"), config({ watchScreen: true })],
      [environmentId("two"), config({ watchScreen: true })],
    ]);
    expect(
      resolveWatchEntryEnvironmentId({
        environments,
        serverConfigs,
        preferredEnvironmentId: environmentId("two"),
      }),
    ).toBe(environmentId("two"));
  });

  it("falls back to the first enabled supported environment when the preference cannot host it", () => {
    const environments = [environment("one"), environment("two")];
    const serverConfigs = new Map([
      [environmentId("one"), config({})],
      [environmentId("two"), config({ watchScreen: true })],
    ]);
    expect(
      resolveWatchEntryEnvironmentId({
        environments,
        serverConfigs,
        preferredEnvironmentId: environmentId("one"),
      }),
    ).toBe(environmentId("two"));
    // A disabled environment never opens the screen even when supported.
    expect(
      resolveWatchEntryEnvironmentId({
        environments: [environment("one", false), environment("two")],
        serverConfigs,
        preferredEnvironmentId: environmentId("one"),
      }),
    ).toBe(environmentId("two"));
  });
});

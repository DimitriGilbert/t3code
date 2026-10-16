import {
  WatchConnectorInstanceId,
  WatchConnectorPackId,
  WatchWidgetSourceId,
  type WatchWidgetExportDocument,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WATCH_WIDGET_FILE_MAX_BYTES,
  describeOversizedWidgetFile,
  parseWatchWidgetExportText,
  watchWidgetExportFileName,
  watchWidgetImportWarnings,
} from "./watchTransfer.ts";

const documentFixture: WatchWidgetExportDocument = {
  format: "t3.watch-widget",
  formatVersion: 1,
  kind: "active-work",
  config: { source: { kind: "threads" } },
};

const emptyContext = { packs: [], instances: [], widgetSources: [] };

describe("parseWatchWidgetExportText", () => {
  it("parses a valid document", () => {
    const parsed = parseWatchWidgetExportText(JSON.stringify(documentFixture));
    expect(parsed.kind).toBe("active-work");
    expect(parsed.formatVersion).toBe(1);
  });

  it("rejects oversized text before parsing", () => {
    expect(() => parseWatchWidgetExportText("x".repeat(WATCH_WIDGET_FILE_MAX_BYTES + 1))).toThrow(
      /512 KB/,
    );
    expect(describeOversizedWidgetFile(WATCH_WIDGET_FILE_MAX_BYTES)).toBeNull();
    expect(describeOversizedWidgetFile(WATCH_WIDGET_FILE_MAX_BYTES + 1)).toMatch(/512 KB/);
  });

  it("rejects non-JSON and non-widget JSON", () => {
    expect(() => parseWatchWidgetExportText("not json {")).toThrow(/not valid JSON/);
    expect(() => parseWatchWidgetExportText('"a string"')).toThrow(/not a T3 widget export/);
    expect(() =>
      parseWatchWidgetExportText(JSON.stringify({ ...documentFixture, format: "t3.watch-page" })),
    ).toThrow(/not a T3 widget export/);
  });

  it("rejects a newer format version with the expected-version message", () => {
    expect(() =>
      parseWatchWidgetExportText(JSON.stringify({ ...documentFixture, formatVersion: 2 })),
    ).toThrow(/format version 2/);
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseWatchWidgetExportText(JSON.stringify({ ...documentFixture, config: "nope" })),
    ).toThrow(/not a valid widget export/);
  });
});

describe("watchWidgetExportFileName", () => {
  it("slugs the kind for first-party widgets and the source tail for agent kinds", () => {
    expect(watchWidgetExportFileName({ kind: "active-work" })).toBe("t3-widget-active-work.json");
    expect(watchWidgetExportFileName({ kind: `agent:watch-widget-source:${"a".repeat(64)}` })).toBe(
      "t3-widget-agent-aaaaaaaa.json",
    );
  });
});

describe("watchWidgetImportWarnings", () => {
  it("warns on an unknown kind", () => {
    const warnings = watchWidgetImportWarnings(
      { ...documentFixture, kind: "hologram" },
      emptyContext,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/isn't a widget kind/);
  });

  it("warns when the pack is missing or its registration is absent", () => {
    const sourceId = WatchWidgetSourceId.make(`watch-widget-source:${"b".repeat(64)}`);
    const packDocument = {
      ...documentFixture,
      kind: `agent:${sourceId}`,
      provenance: "pack:pack.test" as const,
    };
    expect(watchWidgetImportWarnings(packDocument, emptyContext)).toHaveLength(1);
    // Pack installed but the widget source registration is gone.
    expect(
      watchWidgetImportWarnings(packDocument, {
        ...emptyContext,
        packs: [{ packId: WatchConnectorPackId.make("pack.test"), archivedAt: null }],
      }),
    ).toHaveLength(1);
    // Both present: no warning.
    expect(
      watchWidgetImportWarnings(packDocument, {
        packs: [{ packId: WatchConnectorPackId.make("pack.test"), archivedAt: null }],
        instances: [],
        widgetSources: [
          {
            packId: WatchConnectorPackId.make("pack.test"),
            sourceId,
            archivedAt: null,
          },
        ],
      }),
    ).toHaveLength(0);
  });

  it("warns on a dangling connector binding", () => {
    const document: WatchWidgetExportDocument = {
      ...documentFixture,
      config: { source: { kind: "connector", binding: "watch-connector-instance:gone" } },
    };
    expect(watchWidgetImportWarnings(document, emptyContext)).toHaveLength(1);
    expect(
      watchWidgetImportWarnings(document, {
        ...emptyContext,
        instances: [
          { id: WatchConnectorInstanceId.make("watch-connector-instance:gone"), archivedAt: null },
        ],
      }),
    ).toHaveLength(0);
  });
});

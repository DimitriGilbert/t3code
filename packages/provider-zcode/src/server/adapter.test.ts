import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";

import { ZcodeSettings } from "../settings.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);
import { buildZcodeAppServerSpawnInput } from "./zcodeAppServer.ts";
import {
  zcodePermissionAnswer,
  zcodePermissionOptionForDecision,
  zcodeRequestKindForTool,
  zcodeSessionModeForRuntimeMode,
  zcodeTimelineMarkerText,
  zcodeToolCallItemStatus,
  zcodeToolItemKind,
  zcodeTurnItemStatusForText,
} from "./zcodeRows.ts";

it("defaults the spawn command to `zcode app-server --stdio`", () => {
  const settings = decodeZcodeSettings({});
  const spawn = buildZcodeAppServerSpawnInput(settings, "/tmp/project", {});
  expect(spawn.command).toBe("zcode");
  expect(spawn.args).toEqual(["app-server", "--stdio"]);
  expect(spawn.cwd).toBe("/tmp/project");
});

it("honors a configured binaryPath", () => {
  const spawn = buildZcodeAppServerSpawnInput(
    { binaryPath: "/opt/zcode/bin/zcode" },
    "/tmp/project",
    {},
  );
  expect(spawn.command).toBe("/opt/zcode/bin/zcode");
});

it("maps runtime modes onto ZCode submission modes", () => {
  expect(zcodeSessionModeForRuntimeMode("approval-required")).toBe("build");
  expect(zcodeSessionModeForRuntimeMode("auto-accept-edits")).toBe("edit");
  expect(zcodeSessionModeForRuntimeMode("auto")).toBe("guarded");
  expect(zcodeSessionModeForRuntimeMode("full-access")).toBe("yolo");
});

it("maps text row states onto turn item statuses", () => {
  expect(zcodeTurnItemStatusForText("streaming")).toBe("running");
  expect(zcodeTurnItemStatusForText("complete")).toBe("completed");
  expect(zcodeTurnItemStatusForText("interrupted")).toBe("interrupted");
  expect(zcodeTurnItemStatusForText("failed")).toBe("failed");
});

it("maps tool-call rows onto T3 item kinds", () => {
  expect(zcodeToolItemKind("Bash")).toBe("command_execution");
  expect(zcodeToolItemKind("Edit")).toBe("file_change");
  expect(zcodeToolItemKind("Write")).toBe("file_change");
  expect(zcodeToolItemKind("WebSearch")).toBe("dynamic_tool");
});

it("maps tool-call statuses onto turn item statuses", () => {
  expect(zcodeToolCallItemStatus("running")).toBe("running");
  expect(zcodeToolCallItemStatus("pendingApproval")).toBe("waiting");
  expect(zcodeToolCallItemStatus("success")).toBe("completed");
  expect(zcodeToolCallItemStatus("error")).toBe("failed");
  expect(zcodeToolCallItemStatus("cancelled")).toBe("cancelled");
});

it("maps gated tool names onto request kinds", () => {
  expect(zcodeRequestKindForTool("Bash")).toBe("command");
  expect(zcodeRequestKindForTool("Edit")).toBe("file-change");
  expect(zcodeRequestKindForTool("Read")).toBe("file-read");
  expect(zcodeRequestKindForTool("Task")).toBe("permission");
});

it("maps T3 approval decisions onto permission options", () => {
  const options = [
    { optionId: "o1", label: "Allow once", kind: "allowOnce" as const },
    { optionId: "o2", label: "Always", kind: "allowAlways" as const },
    { optionId: "o3", label: "Deny", kind: "deny" as const },
  ];
  expect(zcodePermissionOptionForDecision({ options, decision: "accept" })?.optionId).toBe("o1");
  expect(zcodePermissionOptionForDecision({ options, decision: "acceptAlways" })?.optionId).toBe(
    "o2",
  );
  expect(zcodePermissionOptionForDecision({ options, decision: "decline" })?.optionId).toBe("o3");
});

it("builds resolveInteraction answers for permission decisions", () => {
  const payload = {
    kind: "permission" as const,
    toolName: "Bash",
    toolCallId: "t1",
    summary: "run ls",
    detail: {},
    options: [
      { optionId: "o1", label: "Allow", kind: "allowOnce" as const },
      { optionId: "o2", label: "Deny", kind: "deny" as const },
    ],
  } satisfies ZCodeSchema.PermissionRequestPayload;
  expect(zcodePermissionAnswer({ payload, decision: "accept" })).toEqual({ optionId: "o1" });
  expect(zcodePermissionAnswer({ payload, decision: "cancel" })).toEqual({ action: "cancel" });
});

it("renders timeline markers into user-facing text", () => {
  const compact = {
    type: "compact" as const,
    origin: "auto" as const,
    status: "success" as const,
    tokensBefore: 1000,
    tokensAfter: 500,
  };
  expect(zcodeTimelineMarkerText(compact)).toBe("Conversation history compacted.");
});

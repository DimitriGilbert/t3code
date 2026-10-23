import { describe, expect, it } from "@effect/vitest";

import { WatchToolkit } from "./tools.ts";

const toolNames = Object.keys(WatchToolkit.tools);

describe("watch MCP toolkit", () => {
  it("registers the request-side connector tools", () => {
    for (const name of [
      "t3_watch_connectors_list",
      "t3_watch_connector_instance_create",
      "t3_watch_connector_instance_update",
      "t3_watch_connector_instance_delete",
      "t3_watch_connector_instance_config_set",
      "t3_watch_connector_request_install",
      "t3_watch_connector_request_upgrade",
      "t3_watch_connector_rollback",
      "t3_watch_connector_uninstall",
      "t3_watch_widget_source_publish",
      "t3_watch_pages_list",
      "t3_watch_widget_export",
      "t3_watch_widget_import",
    ]) {
      expect(toolNames).toContain(name);
    }
  });

  it("registers no tool that can mint or consume a confirmation", () => {
    // The human-confirm leg (prepare/confirm/purge) is RPC-only so nothing an
    // agent runs can approve its own install request.
    for (const name of toolNames) {
      expect(name).not.toMatch(/confirm|prepare|purge/i);
    }
    expect(toolNames).not.toContain("t3_watch_connector_confirm_install");
    expect(toolNames).not.toContain("t3_watch_connector_confirm_upgrade");
    expect(toolNames).not.toContain("t3_watch_connector_prepare_confirm");
    expect(toolNames).not.toContain("t3_watch_connector_prepare_purge");
    expect(toolNames).not.toContain("t3_watch_connector_purge_instance_data");
  });
});

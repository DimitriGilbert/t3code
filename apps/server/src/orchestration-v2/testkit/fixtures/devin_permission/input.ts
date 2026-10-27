import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_PERMISSION_APPROVED_COMMAND = "rm /tmp/devin-permission-approved";
export const DEVIN_PERMISSION_DECLINED_COMMAND = "rm /tmp/devin-permission-declined";

/**
 * The `auto` runtime mode maps onto Devin's `smart` session mode, which
 * escalates gated commands like `rm` to asks. The first ask is approved and
 * runs through a client terminal; the second is declined and never reaches
 * a terminal.
 */
export function devinPermissionInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    steps: [
      {
        type: "message",
        text: `Run \`${DEVIN_PERMISSION_APPROVED_COMMAND}\` once with your shell/exec tool, then reply DONE.`,
      },
      { type: "approve_next_runtime_request" },
      {
        type: "message",
        text: `Run \`${DEVIN_PERMISSION_DECLINED_COMMAND}\` once with your shell/exec tool. If it is rejected, do not retry; reply REJECTED.`,
      },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}

import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_PERMISSION_APPROVED_COMMAND = "rm /tmp/devin-permission-approved";
export const DEVIN_PERMISSION_DECLINED_COMMAND = "rm /tmp/devin-permission-declined";

/**
 * The `auto` runtime mode maps onto Devin's `smart` session mode, which
 * auto-approves what it judges safe and escalates the rest — `rm` is gated.
 * The first ask is approved and the command runs through a client terminal;
 * the second is declined and its exec tool call never reaches a terminal.
 * (Recorded live — verified option set for the exec ask is
 * [allow_once, allow_session, allow_always, allow_always_global, reject_once].)
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

import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_PERMISSION_APPROVED_COMMAND = "touch zcode-approved.txt";
export const ZCODE_PERMISSION_DECLINED_COMMAND = "touch zcode-declined.txt";

/**
 * Approval-required maps onto ZCode's `build` submission mode, whose
 * `pendingInteractions` permissions the user must answer via
 * `resolveInteraction`. The first command is approved and runs; the second is
 * declined, so its tool call reports failed.
 */
export function zcodePermissionInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      {
        type: "message",
        text: `Run \`${ZCODE_PERMISSION_APPROVED_COMMAND}\` with Bash, then reply DONE.`,
      },
      { type: "approve_next_runtime_request" },
      {
        type: "message",
        text: `Run \`${ZCODE_PERMISSION_DECLINED_COMMAND}\` with Bash once. If it is rejected, do not retry; reply REJECTED.`,
      },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}

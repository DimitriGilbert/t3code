import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_PERMISSION_APPROVED_COMMAND = "touch zcode-approved.txt";
export const ZCODE_PERMISSION_DECLINED_COMMAND = "touch zcode-declined.txt";

/**
 * Approval-required maps onto ZCode's `build` session mode, whose permission
 * asks the user must answer. The first command is approved and runs; the
 * second is declined, so its call reports failed. (The guarded/auto
 * escalation is covered by the zcodePermissionDisposition unit tests — it
 * only engages when the policy carries no approval/sandbox override.)
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

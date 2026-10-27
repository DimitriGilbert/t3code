/**
 * Devin's typed `cognition.ai/*` session metadata: subagent-context routing,
 * grouped streaming message ids, and real tool names. The ACP Registry's
 * `agentId: "devin"` special case reuses these.
 *
 * @module provider-devin/server/devinSessionUpdates
 */
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeDevinSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const meta = record("_meta" in update ? update._meta : undefined);
  const parentAgentId = record(meta?.["cognition.ai/subagent_context"])?.parentAgentId;
  const routed =
    typeof parentAgentId === "string" && parentAgentId !== "root"
      ? { ...notification, sessionId: parentAgentId }
      : notification;
  const messageId = meta?.["cognition.ai/streamingMessageId"];
  if (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    typeof messageId === "string"
  ) {
    return { ...routed, update: { ...update, messageId } };
  }
  return routed;
}

export function normalizeDevinToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = record(tool.data.meta)?.["cognition.ai/inferenceToolName"];
  return typeof name === "string" && (!tool.title || tool.title === "Tool")
    ? { ...tool, title: name }
    : tool;
}

/**
 * The proposed-plan markdown Devin writes mid-turn through `write_plan`
 * (verified live). `exit_plan_mode` is deliberately not a source — its
 * `rawInput.plan` is a one-line summary that would overwrite the capture.
 */
export function extractDevinProposedPlanMarkdown(tool: AcpToolCallState): string | undefined {
  const meta = record(tool.data.meta);
  const isPlanWrite =
    meta?.["cognition.ai/isPlanFileEdit"] === true ||
    meta?.["cognition.ai/inferenceToolName"] === "write_plan";
  if (!isPlanWrite) return undefined;
  const rawInput = record(tool.data.rawInput);
  for (const key of ["content", "plan"] as const) {
    const value = rawInput?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  const content = tool.data.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const diff = record(block);
      if (diff?.type !== "diff") continue;
      const newText = typeof diff.newText === "string" ? diff.newText : undefined;
      if (newText === undefined) continue;
      // Plan-file diffs carry a `---`-delimited devin-local frontmatter block.
      const stripped = newText.replace(/^---\n[\s\S]*?\n---\n/, "");
      if (stripped.trim().length > 0) return stripped;
    }
  }
  return undefined;
}

export function extractDevinSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const meta = record(tool.data.meta);
  const completed = record(meta?.["cognition.ai/subagent_completed"]);
  const started = record(meta?.["cognition.ai/subagent_started"]);
  const data = completed ?? started;
  if (typeof data?.agentId !== "string") return undefined;
  return {
    nativeTaskId: data.agentId,
    childSessionId: data.agentId,
    prompt: typeof started?.task === "string" ? started.task : "",
    title: typeof started?.title === "string" ? started.title : null,
    model: typeof started?.model === "string" ? started.model : null,
    status: completed ? (completed.success === false ? "failed" : "completed") : "running",
    result: typeof completed?.summary === "string" ? completed.summary : null,
  };
}

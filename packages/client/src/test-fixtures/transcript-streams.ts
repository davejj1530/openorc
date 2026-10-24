import type { AgentEvent } from "@openorc/protocol";
import { codexRecorded } from "./codex-recorded.js";

/**
 * Event streams for the transcript golden replay. `codex` was recorded from the real Codex adapter driven by a scripted
 * app-server; the rest are written by hand to reach every branch of the projection: Claude's explicit thinking,
 * approvals and questions, expiring approvals, stderr, MCP declarations after completion, image activity, fatal
 * errors and events the projection ignores.
 */
type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "runId" | "ts" | "eventId"> : never) : never;

function stream(runId: string, drafts: Draft[], start = 1_760_000_100_000): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId, ts: start + index * 23, eventId: `${runId}-${String(index).padStart(3, "0")}` }) as AgentEvent);
}

function tokens(text: string): string[] {
  return text.split(/(?<= )/);
}

const claudeReply = "I traced the timeout to the retry queue. The store publishes once per frame, so the assertion has to wait for a frame before it reads the run.";

function claude(): AgentEvent[] {
  const runId = "golden-claude";
  const longOutput = Array.from({ length: 40 }, (_, i) => `src/lib/module-${i}.ts:${i + 3}:  const value${i} = await load(${i});\n`);
  return stream(runId, [
    { type: "session.started", agent: "claude", externalSessionId: "sess-golden", model: "claude-opus-5-5", tools: ["Bash", "Read", "Edit"] },
    { type: "turn.started", turnId: "t1" },
    { type: "message.completed", messageId: "user-1", role: "user", text: "Why does the retry test time out?", attachments: ["/Users/me/.openorc/attachments/a1.png"] },
    { type: "thinking.started", messageId: "th-1" },
    ...tokens("Look at the queue drain first, then the publish schedule.").map((text): Draft => ({ type: "thinking.delta", messageId: "th-1", text })),
    { type: "thinking.completed", messageId: "th-1", text: "Look at the queue drain first, then the publish schedule." },
    ...tokens(claudeReply).map((text): Draft => ({ type: "message.delta", messageId: "m-1", role: "assistant", text })),
    { type: "message.completed", messageId: "m-1", role: "assistant", text: claudeReply },
    { type: "tool.started", toolCallId: "tu-grep", name: "Grep", input: { pattern: "await load", path: "src" }, parentToolCallId: null },
    ...longOutput.map((text): Draft => ({ type: "tool.output.delta", toolCallId: "tu-grep", text })),
    { type: "tool.completed", toolCallId: "tu-grep", name: "Grep", output: longOutput.join(""), isError: false },
    { type: "tool.started", toolCallId: "tu-bash", name: "Bash", input: { command: "rm -rf dist && pnpm build", description: "Rebuild" }, parentToolCallId: null },
    { type: "approval.requested", approvalId: "ap-bash", kind: "command", toolName: "Bash", input: { command: "rm -rf dist && pnpm build" }, reason: "Deletes files" },
    { type: "usage.updated", usage: { inputTokens: 9000, outputTokens: 300, contextTokens: 9300, contextWindow: 200_000 } },
    { type: "approval.resolved", approvalId: "ap-bash", decision: "allow_for_run" },
    { type: "tool.updated", toolCallId: "tu-bash", progress: "Building 3 of 7" },
    { type: "tool.output.delta", toolCallId: "tu-bash", text: "vite v8 building for production...\n" },
    { type: "tool.updated", toolCallId: "tu-bash", input: { command: "rm -rf dist && pnpm build", description: "Rebuild the app" } },
    { type: "tool.completed", toolCallId: "tu-bash", name: "Bash", output: undefined, isError: false },
    {
      type: "approval.requested",
      approvalId: "ap-ask",
      kind: "user_input",
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "Keep the fake clock?", options: [{ label: "Yes" }, { label: "No" }] }] },
    },
    { type: "approval.resolved", approvalId: "ap-ask", decision: "allow", answers: { "Keep the fake clock?": ["Yes"] } },
    { type: "tool.started", toolCallId: "tu-mcp", name: "mcp__screens__search", input: { query: "retry" }, parentToolCallId: null, mcp: { server: "screens", tool: "search" } },
    { type: "tool.completed", toolCallId: "tu-mcp", name: "mcp__screens__search", output: { content: [{ type: "text", text: "2 screens" }] }, isError: false },
    { type: "tool.updated", toolCallId: "tu-mcp", mcp: { server: "screens", tool: "search", resourceUri: "ui://screens/gallery" } },
    { type: "error", message: "warning: deprecated flag --legacy", fatal: false },
    { type: "error", message: "warning: cache miss", fatal: false },
    { type: "background.updated", running: 1, commands: [{ id: "bg-1", description: "pnpm dev" }] },
    { type: "approval.requested", approvalId: "ap-once", kind: "tool", toolName: "WebFetch", input: { url: "https://example.com" }, onceOnly: true },
    { type: "turn.completed", turnId: "t1", status: "cancelled", durationMs: 41_250, usage: { inputTokens: 12_345, outputTokens: 678 } },
    { type: "turn.started", turnId: "t2" },
    { type: "message.completed", messageId: "user-2", role: "user", text: "Delegate the docs update." },
    { type: "thinking.delta", messageId: "th-2", text: "A subagent can write the docs" },
    { type: "tool.started", toolCallId: "tu-task", name: "Task", input: { description: "Update the docs", prompt: "Explain the retry rule" }, parentToolCallId: null },
    { type: "tool.started", toolCallId: "tu-child", name: "Read", input: { file_path: "docs/retry.md" }, parentToolCallId: "tu-task" },
    { type: "tool.completed", toolCallId: "tu-child", name: "Read", output: "# Retry", isError: false },
    { type: "tool.completed", toolCallId: "tu-task", name: "Task", output: "Docs updated", isError: false, status: "success" },
    { type: "plan.updated", documentId: "plan-1", text: "1. Read docs\n2. Update", complete: true },
    { type: "context.updated", contextTokens: 50_000, contextWindow: 200_000 },
    { type: "turn.completed", turnId: "t2", status: "success", durationMs: 9_000 },
    { type: "session.completed", status: "success", durationMs: 60_000, turns: 2 },
  ]);
}

function failure(): AgentEvent[] {
  const runId = "golden-failure";
  return stream(runId, [
    { type: "session.started", agent: "codex", externalSessionId: null, model: null },
    { type: "turn.started", turnId: "f1" },
    { type: "activity.updated", activityId: "img", label: "Generating image", status: "running", activityKind: "image_generation", detail: { status: "inProgress" } },
    { type: "activity.delta", activityId: "img", label: "Generating image", text: "Sketching" },
    { type: "activity.delta", activityId: "img", label: "Generating image", text: " the layout" },
    { type: "activity.updated", activityId: "img", label: "Generated image", status: "success", activityKind: "image_generation", imagePath: "/tmp/img.png", detail: { savedPath: "/tmp/img.png" } },
    { type: "activity.updated", activityId: "quota", label: "Provider error", status: "error", text: "Usage limit reached", recovery: { kind: "usage", provider: "codex" } },
    { type: "activity.delta", activityId: "new-activity", label: "Compacting context", text: "Folding" },
    { type: "thinking.delta", messageId: "th-f", text: "Retrying with a smaller prompt" },
    { type: "raw", agent: "codex", payload: { method: "noise" } },
    { type: "tool.started", toolCallId: "open-tool", name: "shell", input: { command: "sleep 100" }, parentToolCallId: null },
    { type: "tool.output.delta", toolCallId: "missing-tool", text: "dropped" },
    { type: "tool.updated", toolCallId: "missing-tool", progress: "dropped" },
    { type: "approval.resolved", approvalId: "missing-approval", decision: "deny" },
    { type: "approval.requested", approvalId: "ap-open", kind: "file_change", input: { path: "a.ts" } },
    { type: "message.delta", messageId: "m-f", role: "assistant", text: "Working on" },
    { type: "thinking.started", messageId: "th-g" },
    { type: "error", message: "Codex exited with code 1", fatal: true },
  ]);
}

/** Every recorded and written stream, by name. */
export const goldenStreams: Record<string, AgentEvent[]> = {
  codex: codexRecorded,
  claude: claude(),
  failure: failure(),
};

/** How a stream is cut into frames: one event each, all at once, and an irregular cut like the 16 ms coalescer's. */
export const frameCuts: Record<string, (events: AgentEvent[]) => AgentEvent[][]> = {
  single: (events) => events.map((event) => [event]),
  whole: (events) => [events],
  irregular: (events) => {
    const sizes = [1, 3, 8, 2, 13, 5, 21];
    const frames: AgentEvent[][] = [];
    for (let at = 0, i = 0; at < events.length; i++) {
      const size = sizes[i % sizes.length]!;
      frames.push(events.slice(at, at + size));
      at += size;
    }
    return frames;
  },
};

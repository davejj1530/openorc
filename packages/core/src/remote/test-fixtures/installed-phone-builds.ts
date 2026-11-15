import { INSTALLED_PHONES } from "@openorc/link/test-fixtures/installed-phone";
import { INSTALLED_TRANSCRIPTS } from "@openorc/link/test-fixtures/installed-transcript";
import type { AgentEvent } from "@openorc/protocol";

/*
 * The phone builds people have installed, as a Mac meets them: how each reads the hello and a pairing code, what it
 * asks `session.negotiate` for (null: it never asks), and the transcript code it runs on every event. Frozen: a build
 * in the field cannot learn anything, so nothing here follows today's protocol.
 * - The first TestFlight build is held to the App Store's transcript: it aborted on subagent events on 2026-11-03.
 * - 1.1.0 as first released carried an earlier copy of the transcript that leaves unknown types out the same way; the
 *   one frozen is what its updates and 1.2.0 run.
 */
export const INSTALLED_BUILDS = [
  { name: "App Store 1.0.0", reader: INSTALLED_PHONES.appStore, capabilities: null, transcript: INSTALLED_TRANSCRIPTS.appStore },
  { name: "TestFlight 1.0.0", reader: INSTALLED_PHONES.testFlight, capabilities: null, transcript: INSTALLED_TRANSCRIPTS.appStore },
  { name: "1.1.0", reader: INSTALLED_PHONES.testFlight, capabilities: ["subagent-threads", "reply-images"], transcript: INSTALLED_TRANSCRIPTS.release },
  { name: "1.1.0 with skills", reader: INSTALLED_PHONES.testFlight, capabilities: ["subagent-threads", "reply-images", "skill-lists"], transcript: INSTALLED_TRANSCRIPTS.release },
  {
    name: "1.2.0",
    reader: INSTALLED_PHONES.testFlight,
    capabilities: ["subagent-threads", "reply-images", "skill-lists", "orclings", "task-details", "subthread-starts", "orcling-edits"],
    transcript: INSTALLED_TRANSCRIPTS.release,
  },
] as const;
export type InstalledBuild = (typeof INSTALLED_BUILDS)[number];

type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "runId" | "ts" | "eventId"> : never) : never;

/**
 * One turn that holds every event type a Mac can send today, each with every field it may carry, in the order a real
 * turn has them. A type added to the protocol belongs here: the test that reads this list names the one missing.
 */
export function everyEvent(runId: string): AgentEvent[] {
  const usage = {
    model: "fixture-model",
    fastMode: true,
    requestInputTokens: 900,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 300,
    cacheWriteTokens: 20,
    costUsd: 0.02,
    contextTokens: 1300,
    contextWindow: 200_000,
  };
  const mcp = { server: "screens", tool: "search", resourceUri: "ui://screens/gallery" };
  const drafts: Draft[] = [
    { type: "session.started", agent: "claude", externalSessionId: "session-one", model: "fixture-model", capabilities: ["steer"], tools: ["Bash", "Read"] },
    { type: "turn.started", turnId: "turn-one" },
    { type: "message.completed", messageId: "prompt", role: "user", text: "Why does the retry test time out?", attachments: ["/attachments/shot.png"] },
    { type: "thinking.started", messageId: "thought" },
    { type: "thinking.delta", messageId: "thought", text: "Look at the queue first." },
    { type: "thinking.completed", messageId: "thought", text: "Look at the queue first." },
    { type: "plan.updated", documentId: "plan", text: "1. Read the queue", delta: false, complete: true },
    { type: "message.delta", messageId: "answer", role: "assistant", text: "The store publishes " },
    { type: "message.completed", messageId: "answer", role: "assistant", text: "The store publishes once per frame." },
    { type: "activity.updated", activityId: "image", label: "Drawing", status: "running", text: "A chart", detail: { size: "1024" }, activityKind: "image_generation" },
    { type: "activity.delta", activityId: "image", label: "Drawing", text: " of the queue" },
    { type: "activity.updated", activityId: "image", label: "Drawing", status: "error", recovery: { kind: "usage", provider: "codex" }, imagePath: "/images/chart.png" },
    { type: "tool.started", toolCallId: "search", name: "mcp__screens__search", input: { query: "retry" }, parentToolCallId: null, mcp },
    { type: "tool.updated", toolCallId: "search", input: { query: "retry queue" }, progress: "2 of 3", mcp },
    { type: "tool.output.delta", toolCallId: "search", text: "2 screens\n" },
    {
      type: "tool.completed",
      toolCallId: "search",
      name: "mcp__screens__search",
      output: { content: [{ type: "text", text: "2 screens" }] },
      mcp,
      isError: false,
      status: "success",
      input: { query: "retry queue" },
      outputOmitted: false,
      digest: { lines: 1, head: ["2 screens"], tail: [] },
    },
    { type: "file.changed", path: "src/queue.ts", kind: "modify", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    { type: "approval.requested", approvalId: "ask", kind: "command", toolName: "Bash", input: { command: "pnpm build" }, reason: "Runs a build", onceOnly: true, durable: true },
    { type: "approval.resolved", approvalId: "ask", decision: "allow", message: "Go on", answers: { "Keep the clock?": ["Yes"] } },
    {
      type: "subagent.started",
      subagentId: "helper",
      parentSubagentId: "lead",
      threadId: "child",
      toolCallId: "search",
      title: "Read docs",
      prompt: "Read them",
      agentType: "explorer",
      group: "Research",
      model: "fixture-model",
      effort: "high",
      background: true,
    },
    { type: "subagent.updated", subagentId: "helper", threadId: "child", status: "completed", taskId: "task", notice: "Done", progress: "3 of 3", result: "Found it", error: "none" },
    { type: "usage.updated", usage },
    { type: "context.updated", contextTokens: 1300, contextWindow: 200_000 },
    { type: "background.updated", running: 1, commands: [{ id: "dev", description: "pnpm dev" }] },
    { type: "error", message: "warning: cache miss", fatal: false },
    { type: "raw", agent: "claude", payload: { native: true } },
    { type: "turn.completed", turnId: "turn-one", status: "success", resultText: "Done", observationEnded: true, usage, durationMs: 4100, fastMode: { state: "cooldown", code: "busy" } },
    { type: "session.completed", status: "success", durationMs: 4200, turns: 1 },
  ];
  return drafts.map((draft, index) => ({ ...draft, runId, ts: 1_760_000_100_000 + index * 23, eventId: `${runId}-${String(index).padStart(3, "0")}` }) as AgentEvent);
}

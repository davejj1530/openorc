/** Representative completed/live turns rendered with the production thread and Hollow. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Transcript } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { applyFrame, getRun, hydrate, resetTranscripts, useTranscripts } from "../../apps/desktop/src/renderer/src/lib/transcript";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";
import type { AgentEvent } from "@openorc/protocol";

let ledger: AgentEvent[] = [];
let counter = 0;
function emit(event: AgentEvent) {
  const stamped = { ...event, eventId: `work-${counter++}` };
  ledger.push(stamped);
  applyFrame({ runId: "work-demo", seq: counter, events: [stamped] });
}
const base = { runId: "work-demo", ts: Date.now() - 222000 };
function seed() {
  resetTranscripts();
  ledger = [];
  counter = 0;
  emit({ ...base, type: "session.started", agent: "codex", externalSessionId: "fixture", model: null });
  emit({ ...base, type: "message.completed", messageId: "user", role: "user", text: "Make the thread feel calmer, with expandable work and clearer icons." });
  emit({ ...base, type: "tool.started", parentToolCallId: null, toolCallId: "graph", name: "mcp__codegraph__codegraph_explore", input: { query: "Transcript groupBlocks" } });
  emit({ ...base, type: "tool.completed", isError: false, toolCallId: "graph", name: "mcp__codegraph__codegraph_explore", output: "Transcript.tsx → groupBlocks → GroupRow" });
  emit({ ...base, type: "thinking.started", messageId: "thinking" });
  emit({ ...base, ts: base.ts + 2000, type: "thinking.completed", messageId: "thinking", text: "Keep the final response readable and retain details behind disclosure." });
  emit({
    ...base,
    type: "tool.completed",
    isError: false,
    toolCallId: "read",
    name: "read_file",
    input: { path: "apps/desktop/src/renderer/src/components/Transcript.tsx" },
    output: "Representative source transcript.\nFull output remains inspectable.",
  });
  emit({
    ...base,
    type: "message.completed",
    messageId: "commentary",
    role: "assistant",
    text: "The repeated thinking rows were splitting related activity. I’m grouping those steps while preserving the full transcript.",
  });
  emit({ ...base, type: "tool.completed", isError: false, toolCallId: "edit", name: "edit", input: { path: "Transcript.tsx" }, output: "Updated" });
  emit({ ...base, type: "tool.completed", isError: false, toolCallId: "test", name: "exec_command", input: { cmd: "pnpm test" }, output: "5 tests passed" });
  emit({ ...base, type: "tool.completed", isError: false, toolCallId: "delegate", name: "spawn_agent", input: { task_name: "Verification" }, output: "Assigned Verification" });
  emit({ ...base, type: "activity.updated", activityId: "agent-finished", label: "Verification finished", status: "success", text: "Reviewed grouping, icons, and live output." });
  emit({
    ...base,
    type: "message.completed",
    messageId: "final",
    role: "assistant",
    text: "The thread now keeps completed work behind a single disclosure. Expand it to inspect tool activity and intermediate updates.\n\nHollow stays at the bottom, with its existing idle and thinking states.",
  });
  emit({ ...base, ts: Date.now(), type: "turn.completed", turnId: "one", status: "success", durationMs: 222000 });
}
/** A turn that recovers: two failed attempts, a successful retry, then success. */
function seedRecovered() {
  resetTranscripts();
  ledger = [];
  counter = 0;
  emit({ ...base, type: "session.started", agent: "codex", externalSessionId: "fixture", model: null });
  emit({ ...base, type: "message.completed", messageId: "user", role: "user", text: "Add an onboarding screen." });
  emit({
    ...base,
    type: "tool.completed",
    toolCallId: "missing-script",
    name: "shell",
    input: { command: "cat scripts/build-mascot-review.cjs" },
    isError: true,
    status: "error",
    output: "cat: scripts/build-mascot-review.cjs: No such file or directory",
  });
  emit({ ...base, type: "tool.completed", toolCallId: "failed-tests", name: "shell", input: { command: "pnpm test" }, isError: true, status: "error", output: "7 failed | 30 passed (37)" });
  emit({ ...base, type: "tool.completed", toolCallId: "fixed-tests", name: "shell", input: { command: "pnpm test" }, isError: false, status: "success", output: "37 passed (37)" });
  emit({
    ...base,
    type: "message.completed",
    messageId: "final",
    role: "assistant",
    text: "Onboarding now uses your Rive mascot. Verified the animations, reduced-motion fallback, typecheck, and 37 tests.",
  });
  emit({ ...base, ts: Date.now(), type: "turn.completed", turnId: "recovered", status: "success", durationMs: 381000 });
}
const params = new URLSearchParams(location.search);
if (params.get("scenario") === "recovered") seedRecovered();
else seed();
useTheme.getState().set(params.get("theme") === "dark" ? "dark" : "light");
core.call = async (method) => (method === "events.page" ? ({ events: ledger, fromTurn: 0, live: false } as never) : ([] as never));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() {
  useTranscripts((s) => s.runs);
  const [working, setWorking] = useState(false);
  Object.assign(window, {
    workSmoke: {
      theme: (theme: "light" | "dark") => useTheme.getState().set(theme),
      reset: () => {
        seed();
        setWorking(false);
      },
      recovered: () => {
        seedRecovered();
        setWorking(false);
      },
      startupFailure: () => {
        resetTranscripts();
        ledger = [];
        counter = 0;
        emit({ ...base, type: "activity.updated", activityId: "startup", label: "Starting OpenCode", status: "success" });
        emit({ ...base, type: "turn.completed", turnId: "startup-turn", status: "error", durationMs: 0 });
        setWorking(false);
      },
      live: () => {
        emit({ ...base, ts: Date.now(), type: "message.completed", messageId: "next-user", role: "user", text: "Run a final check." });
        emit({ ...base, ts: Date.now(), type: "tool.started", parentToolCallId: null, toolCallId: "live-command", name: "exec_command", input: { cmd: "pnpm test --watch" } });
        setWorking(true);
      },
      chunk: () => emit({ ...base, ts: Date.now(), type: "tool.output.delta", toolCallId: "live-command", text: "live output chunk\n" }),
      complete: () => {
        emit({ ...base, ts: Date.now(), type: "turn.completed", turnId: "two", status: "success", durationMs: 12000 });
        setWorking(false);
      },
      fail: () => {
        emit({ ...base, ts: Date.now(), type: "tool.completed", toolCallId: "live-command", name: "exec_command", isError: true, output: "Check failed; inspect the output." });
        emit({ ...base, ts: Date.now(), type: "turn.completed", turnId: "two", status: "error", durationMs: 12000 });
        setWorking(false);
      },
      reload: async () => {
        resetTranscripts();
        await hydrate("work-demo");
      },
    },
  });
  const run = getRun("work-demo");
  return <QueryClientProvider client={client}>{run ? <Transcript run={run} working={working} /> : <div>Loading history…</div>}</QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);

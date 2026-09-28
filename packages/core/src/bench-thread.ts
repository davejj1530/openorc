import { randomUUID } from "node:crypto";
import { runs, threads, type Db, type LedgerWriter } from "@openorc/db";
import { WORKSPACE_ID, type AgentEvent } from "@openorc/protocol";

/** An event before its run and time are stamped on. */
type Unstamped = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "runId" | "ts"> : never) : never;

/**
 * A thread shaped like the largest real one measured: 15 runs, 119 turns and about five thousand transcript rows,
 * each turn with its reasoning, tool calls (some with large output), activity and a markdown reply. The renderer
 * benchmark opens it and streams into its newest run.
 */
export function seedBenchThread(db: Db, ledger: LedgerWriter): { threadId: string; runIds: string[] } {
  const thread = threads.insert(db, { projectId: WORKSPACE_ID, title: "Benchmark thread", agent: "codex", model: "bench", mode: "act", permissionMode: "trusted" });
  const runIds: string[] = [];
  const turnsPerRun = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7];
  let ts = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const turns of turnsPerRun) {
    const runId = randomUUID();
    runs.insert(db, { id: runId, taskId: null, threadId: thread.id, agent: "codex", model: "bench", mode: "act", permissionMode: "trusted" });
    runIds.push(runId);
    const emit = (ev: Unstamped) => ledger.push({ ...ev, runId, ts: (ts += 700) } as AgentEvent);
    emit({ type: "session.started", agent: "codex", externalSessionId: runId, model: "bench" });
    for (let turn = 0; turn < turns; turn++) {
      const id = (name: string) => `${runId}-${turn}-${name}`;
      emit({ type: "message.completed", messageId: id("ask"), role: "user", text: `Turn ${turn}: look into the export path and fix what you find.` });
      for (let step = 0; step < 24; step++) {
        if (step % 2 === 0) emit({ type: "thinking.completed", messageId: id(`think-${step}`), text: `Checking step ${step}: the writer escapes quotes but not newlines.` });
        const call = id(`call-${step}`);
        const command = step % 3 === 0 ? "pnpm test" : `sed -n 1,200p src/export-${step}.ts`;
        emit({ type: "tool.started", toolCallId: call, name: "shell", input: { command }, parentToolCallId: null });
        const output = step % 2 === 0 ? `line of output ${step}\n`.repeat(260) : `ok ${step}\n`.repeat(20);
        emit({ type: "tool.completed", toolCallId: call, name: "shell", input: { command }, output, isError: false });
      }
      for (const n of [1, 2, 3]) emit({ type: "activity.updated", activityId: id(`activity-${n}`), label: n === 3 ? "Changes" : "Plan", status: "success", text: `- step ${n} done` });
      emit({ type: "message.completed", messageId: id("note"), role: "assistant", text: "Found the cause; editing the writer now." });
      emit({
        type: "message.completed",
        messageId: id("reply"),
        role: "assistant",
        text: `Fixed the CSV writer in turn ${turn}.\n\n- Quotes are doubled\n- Newlines are kept inside quoted fields\n\n\`\`\`ts\nexport function cell(value: string): string {\n  return /[",\\n]/.test(value) ? \`"\${value.replace(/"/g, '""')}"\` : value;\n}\n\`\`\`\n\nAll **37** tests pass.`,
      });
      emit({ type: "turn.completed", turnId: id("turn"), status: "success", durationMs: 90_000 });
    }
    emit({ type: "session.completed", status: "success", durationMs: turns * 90_000 });
    runs.update(db, runId, { state: "success", endedAt: ts });
  }
  ledger.flush();
  return { threadId: thread.id, runIds };
}

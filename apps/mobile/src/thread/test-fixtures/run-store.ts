import { createClientState, type CoreConnection, type RunTranscript } from "@openorc/client";
import type { AgentEvent } from "@openorc/protocol";

export type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "runId" | "ts" | "eventId"> : never) : never;

/**
 * The real run store over a connection that never answers: frames go through the same reducer the app uses. With
 * `interest` delivery, as the phone's link has, `interest()` is the runs the store last asked the core to stream.
 */
export function runStore(delivery: CoreConnection["delivery"] = "all") {
  let interest: ReadonlySet<string> = new Set();
  const connection: CoreConnection = {
    delivery,
    call: () => new Promise(() => undefined),
    onPush: () => () => undefined,
    setFrameInterest: (runIds) => {
      interest = runIds;
    },
  };
  const client = createClientState(connection, { scheduleFrame: () => undefined, invalidationBatchMs: 50, randomId: () => "id", savesDefaultPermission: false });
  const { runs } = client;
  let seq = 0;
  const frame = (...drafts: Draft[]) => {
    runs.applyFrame({ runId: "r", seq: ++seq, events: drafts.map((draft, i) => ({ ...draft, runId: "r", ts: 1_000 + seq * 100 + i, eventId: `e${seq}-${i}` }) as AgentEvent) });
    runs.flush();
    return runs.get("r")!;
  };
  return { client, frame, interest: () => interest };
}

/** What the thread screen tells the transcript of a run: its newest turn may run while the run lives, and the thread works while a turn is open. */
export const activity = (run: RunTranscript) => ({ live: run.live, working: run.turnOpen });

/** A turn that asked, listed a folder and answered. */
export const finishedTurn: Draft[] = [
  { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
  { type: "turn.started", turnId: "t1" },
  { type: "message.completed", messageId: "ask-1", role: "user", text: "List the folder" },
  { type: "tool.started", toolCallId: "ls", name: "commandExecution", input: { command: "ls -la" }, parentToolCallId: null },
  { type: "tool.completed", toolCallId: "ls", name: "commandExecution", output: "total 0", isError: false },
  { type: "message.completed", messageId: "reply-1", role: "assistant", text: "Done." },
  { type: "turn.completed", turnId: "t1", status: "success", durationMs: 2_000 },
];

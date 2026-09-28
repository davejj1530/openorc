import { audit, orchestration, teamDeletedThreads, teamRuntime, threads, type Db } from "@openorc/db";
import type { TeamMailboxMessage } from "@openorc/protocol";
import type { TeamCoordinator } from "./team-coordinator.js";

export interface TeamThreadMessage {
  threadId: string;
  text: string;
  requestKey: string;
  source: { threadId: string; title: string; member?: string | null; team?: string | null };
}

/** Permission admission is shared with ordinary thread_send; this retains team delivery. */
export function relayTeamThreadMessage(db: Db, coordinator: TeamCoordinator, input: TeamThreadMessage): TeamMailboxMessage {
  const thread = threads.get(db, input.threadId);
  const instance = orchestration.getInstance(db, input.threadId);
  const from = threads.get(db, input.source.threadId);
  if (!thread || !instance) throw new Error("This conversation has no saved team.");
  if (!from || from.projectId !== thread.projectId || from.id === thread.id) throw new Error("Messages travel only between different threads of the same project.");
  if (teamDeletedThreads.has(db, thread.id)) throw new Error("This conversation was deleted.");
  if (thread.archivedAt) throw new Error("The team conversation is archived.");
  if (!input.text.trim() || input.text.length > 100_000) throw new Error("Messages need bounded text.");
  const active = teamRuntime.activeForThread(db, thread.id);
  if (!active) throw new Error("The team is not running right now. Its lead receives messages only during an execution; ask the user to start it.");
  const sender = input.source.member ? ` sent by ${input.source.member}${input.source.team ? ` of team ${input.source.team}` : ""}` : "";
  const body = `Message from the thread "${input.source.title}" (id ${input.source.threadId})${sender}:\n\n${input.text}`;
  const message = coordinator.messageFromThread(active.id, { sourceThreadId: input.source.threadId, body, requestKey: input.requestKey });
  audit.record(db, {
    actor: input.source.member ? "agent" : "user",
    action: "thread.message",
    resourceType: "thread",
    resourceId: thread.id,
    metadata: { from: input.source.threadId, messageId: message.id, executionId: active.id },
  });
  return message;
}

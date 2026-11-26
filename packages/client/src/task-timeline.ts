import { harnessShortName, type TaskEvent, type TaskStatus, type TaskUpdateCard } from "@openorc/protocol";

/** A run of words in a timeline line. A strong word names who or where; one with a thread opens that thread. */
export type TaskLineWord = { text: string; strong?: boolean; threadId?: string };
/** What leads a line: the person, a move across the board, or the agent that acted. */
export type TaskLineLead = { kind: "person" } | { kind: "move" } | { kind: "agent"; agent: string };
/** What an agent's update carries under its words: its card, the replies it offers and the one the person pressed. */
export type TaskLineUpdate = { card: TaskUpdateCard | null; replies: string[]; answer: { reply: string; at: number } | null; threadId: string | null };
export type TaskLine = { id: number; at: number; lead: TaskLineLead; words: TaskLineWord[]; update?: TaskLineUpdate };

const agentWord = (agent: string, threadId: string | null): TaskLineWord => ({ text: harnessShortName(agent), strong: true, ...(threadId ? { threadId } : {}) });

function created(event: Extract<TaskEvent, { kind: "created" }>): TaskLine {
  const { actor } = event;
  if (actor.kind === "agent") return { id: event.id, at: event.at, lead: { kind: "agent", agent: actor.agent }, words: [agentWord(actor.agent, actor.threadId), { text: " created the task" }] };
  return { id: event.id, at: event.at, lead: { kind: "person" }, words: actor.kind === "user" ? [{ text: "You", strong: true }, { text: " created the task" }] : [{ text: "Created" }] };
}

function moved(event: Extract<TaskEvent, { kind: "moved" }>, statusNames: Record<TaskStatus, string>): TaskLine {
  const place: TaskLineWord = { text: event.column ?? statusNames[event.status], strong: true };
  const { actor } = event;
  const words = actor.kind === "agent" ? [agentWord(actor.agent, actor.threadId), { text: " moved it to " }, place] : [{ text: "Moved to " }, place];
  return { id: event.id, at: event.at, lead: { kind: "move" }, words };
}

function update(event: Extract<TaskEvent, { kind: "update" }>): TaskLine {
  const { actor } = event;
  const threadId = actor.kind === "agent" ? actor.threadId : null;
  return {
    id: event.id,
    at: event.at,
    lead: actor.kind === "agent" ? { kind: "agent", agent: actor.agent } : { kind: "person" },
    words: [{ text: event.message, strong: true }],
    update: { card: event.card ?? null, replies: event.replies ?? [], answer: event.answer, threadId },
  };
}

/**
 * A task's history as lines to read, oldest first. A job that started straight after a move reads as part of it:
 * "Moved to Build, which started Claude".
 */
export function taskTimeline(events: readonly TaskEvent[], statusNames: Record<TaskStatus, string>): TaskLine[] {
  const lines: TaskLine[] = [];
  events.forEach((event, index) => {
    if (event.kind === "created") lines.push(created(event));
    else if (event.kind === "moved") lines.push(moved(event, statusNames));
    else if (event.kind === "update") lines.push(update(event));
    else if (events[index - 1]?.kind === "moved") lines.at(-1)!.words.push({ text: ", which started " }, agentWord(event.agent, event.threadId));
    else
      lines.push({
        id: event.id,
        at: event.at,
        lead: { kind: "agent", agent: event.agent },
        words: [{ text: event.label, strong: true }, { text: " started " }, agentWord(event.agent, event.threadId)],
      });
  });
  return lines;
}

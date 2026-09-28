import type { TeamActorView, TeamChatEntry, TeamExecutionView } from "@openorc/protocol";
import type { TeamContextCheckpoint } from "./team-context";

type Direction = TeamExecutionView["userDirections"][number];

/**
 * One execution as a time-ordered feed. Members appear only when they act:
 * each provider turn is an item, placed where it finished (a running turn
 * where it started), so an idle member has no presence at all.
 */
export type TeamFeedItem =
  | { kind: "prompt"; at: number }
  | { kind: "direction"; at: number; direction: Direction }
  | { kind: "chat"; at: number; entry: TeamChatEntry; continued: boolean }
  | { kind: "turn"; at: number; actor: TeamActorView; runId: string; turnId: string; turn: number; order: number; continued: boolean; last: boolean }
  | { kind: "checkpoint"; at: number; checkpoint: TeamContextCheckpoint; actor: TeamActorView }
  | { kind: "assignment"; at: number; actor: TeamActorView };

/** Roster members in the chat: the lead and its participants. Isolated assignments carry a task. */
export const isTeamMember = (actor: Pick<TeamActorView, "taskId">) => actor.taskId === null;

const rank: Record<TeamFeedItem["kind"], number> = { prompt: 0, direction: 1, chat: 1, checkpoint: 2, assignment: 3, turn: 4 };
// Turns without a start time fall back to the actor's creation; the tie-break then keeps one member's turns together and in run order.
function identity(item: TeamFeedItem): string {
  switch (item.kind) {
    case "prompt":
      return "";
    case "direction":
      return item.direction.id;
    case "chat":
      return item.entry.id;
    case "turn":
      return `${item.actor.id}:${String(item.order).padStart(6, "0")}`;
    case "checkpoint":
      return item.checkpoint.id;
    case "assignment":
      return item.actor.id;
  }
}
/** Who authored an item, for collapsing consecutive headers the way a chat does. */
function author(item: TeamFeedItem | undefined): string | null {
  if (item?.kind === "turn") return item.actor.runs?.find((run) => run.turnId === item.turnId)?.reason === "ambient" ? null : item.actor.id;
  if (item?.kind === "chat" && item.entry.senderId !== "user") return item.entry.senderId;
  return null;
}

export function teamFeed(execution: TeamExecutionView, checkpoints: TeamContextCheckpoint[] = []): TeamFeedItem[] {
  const members = execution.actors.filter(isTeamMember);
  const memberIds = new Set(members.map((actor) => actor.id));
  const items: TeamFeedItem[] = [];
  // An opening message addressed to members is already a chat entry, with its delivery.
  if (!execution.initialPrompt.chatId) items.push({ kind: "prompt", at: execution.initialPrompt.createdAt });
  // Directions keep their own arrival position even when a completed turn moves.
  for (const direction of execution.userDirections) {
    items.push({ kind: "direction", at: direction.createdAt, direction });
  }
  for (const entry of execution.chat ?? []) items.push({ kind: "chat", at: entry.createdAt, entry, continued: false });
  for (const actor of members) {
    // A projection recorded before turns were identified separately still lists its processes, one turn each.
    const turns: Pick<TeamActorView["runs"][number], "id" | "turnId" | "turn" | "startedAt" | "endedAt">[] = actor.runs?.length
      ? actor.runs
      : actor.runIds.map((id) => ({ id, turnId: id, turn: 0, startedAt: 0 }));
    for (const [order, run] of turns.entries())
      items.push({ kind: "turn", at: run.endedAt ?? (run.startedAt || actor.createdAt), actor, runId: run.id, turnId: run.turnId, turn: run.turn, order, continued: false, last: false });
  }
  for (const checkpoint of checkpoints) {
    const actor = checkpoint.reason === "fresh_retry" && checkpoint.executionId === execution.id ? members.find((candidate) => candidate.id === checkpoint.actorId) : undefined;
    if (actor) items.push({ kind: "checkpoint", at: checkpoint.createdAt, checkpoint, actor });
  }
  // Nested assignments stay inside their manager's card.
  for (const actor of execution.actors) {
    if (!isTeamMember(actor) && actor.parentId !== null && memberIds.has(actor.parentId)) items.push({ kind: "assignment", at: actor.createdAt, actor });
  }
  items.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind] || identity(a).localeCompare(identity(b)));
  const lastTurn = new Map<string, TeamFeedItem>();
  items.forEach((item, index) => {
    const previous = author(items[index - 1]);
    if (item.kind === "turn") {
      item.continued = previous === item.actor.id;
      const previousTurn = lastTurn.get(item.actor.id);
      if (previousTurn?.kind !== "turn" || previousTurn.order < item.order) lastTurn.set(item.actor.id, item);
    }
    if (item.kind === "chat") item.continued = previous !== null && previous === item.entry.senderId;
  });
  for (const item of lastTurn.values()) if (item.kind === "turn") item.last = true;
  return items;
}

/** Members whose turn is in progress, in roster order: "Mark and Melo are working". */
export function teamWorkingStatus(
  actors: (Pick<TeamActorView, "memberKey" | "activeRunId" | "taskId"> & Partial<Pick<TeamActorView, "runs">>)[],
  members: { key: string; name: string }[],
): string | null {
  const live = actors.filter((actor) => actor.activeRunId && isTeamMember(actor));
  const reading = new Set(live.filter((actor) => actor.runs?.findLast((run) => run.id === actor.activeRunId)?.reason === "ambient").map((actor) => actor.memberKey));
  const working = new Set(live.filter((actor) => !reading.has(actor.memberKey)).map((actor) => actor.memberKey));
  const phrase = (keys: Set<string>, verb: string) => {
    const names = members.filter((member) => keys.has(member.key)).map((member) => member.name);
    if (!names.length) return null;
    if (names.length === 1) return `${names[0]} is ${verb}`;
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are ${verb}`;
  };
  const parts = [phrase(working, "working"), phrase(reading, "reading")].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : null;
}

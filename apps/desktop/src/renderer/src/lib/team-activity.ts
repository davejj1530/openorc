import type { TeamActorView, TeamChatEntry, TeamExecutionView } from "@openorc/protocol";
import type { Block } from "./transcript";

/** One of an assignment's turns, with the assignments it delegated during that turn. */
export interface TeamActivityGroup {
  id: string;
  runId: string | null;
  actors: TeamActorView[];
}

export function hasOpenTeamExecution(executions: Pick<TeamExecutionView, "state">[]): boolean {
  return executions.some((execution) => execution.state !== "completed" && execution.state !== "stopped");
}

/** Claiming reserves a turn; successful turn capture confirms receipt. */
export function teamDirectionStatus(
  direction: TeamExecutionView["userDirections"][number],
  leadName: string,
  context: { executionState: TeamExecutionView["state"]; leadState: TeamActorView["state"] },
): string | null {
  if (!direction.state) return null;
  if (direction.state === "cancelled") return "Cancelled";
  if (direction.state === "delivered" || direction.live?.state === "accepted") return "Sent";
  if (direction.live?.state === "uncertain") return "Couldn’t confirm delivery · review before retrying";
  if (context.executionState === "stopped" || context.executionState === "stopping") return "Couldn’t send · team stopped";
  if (context.leadState === "attention") return `Couldn’t send · ${leadName} needs attention`;
  if (direction.live?.state === "reserved" || direction.state === "claimed") return "Sending…";
  if (direction.state === "pending") return "Queued for next turn";
  return null;
}

/** An assignment's own turns, each holding the assignments it delegated; one that has not run yet has a single group. */
export function teamActivityGroups(execution: TeamExecutionView, owner: TeamActorView): TeamActivityGroup[] {
  const groups: TeamActivityGroup[] = owner.runIds.map((id) => ({ id, runId: id, actors: [] }));
  if (!groups.length) groups.push({ id: `pending-${owner.id}`, runId: null, actors: [] });
  const runOfTurn = new Map((owner.runs ?? []).map((run) => [run.turnId, run.id]));
  const children = execution.actors.filter((actor) => actor.parentId === owner.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const actor of children) {
    const runId = actor.dispatchedBy ? runOfTurn.get(actor.dispatchedBy) : undefined;
    (groups.find((group) => group.runId === runId) ?? groups.at(-1)!).actors.push(actor);
  }
  return groups;
}

/** A turn's own activity. Its provider inputs, such as team direction and coordinator handoffs, are not conversation messages. */
export function teamRunBlocks(blocks: Block[]): Block[] {
  return blocks.filter((block) => block.kind !== "message" || block.role === "assistant");
}

/** Per-addressee chat delivery, compact enough to sit beside the name. */
export function teamChatDeliveryStatus(to: TeamChatEntry["to"][number]): string {
  if (to.state === "cancelled") return "Cancelled";
  if (to.state === "delivered" || to.live === "accepted") return "Sent";
  if (to.live === "uncertain") return "Couldn’t confirm delivery · review before retrying";
  if (to.live === "reserved" || to.state === "claimed") return "Sending…";
  return "Queued for next turn";
}

/** Compact file list for member cards: the first few paths, then a count. */
export function teamFileList(paths: string[], limit = 8): string {
  const shown = paths.slice(0, limit).join(", ");
  const rest = paths.length - limit;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** Only inspect the currently owning turn; old warm-process blocks cannot describe today's work. */
export function teamMemberActivity(actor: TeamActorView, blocks: Block[]): string {
  if (actor.modeHold) return "Waiting for Act";
  if (actor.state === "attention") return "Needs attention";
  if (actor.state === "starting") return "Starting…";
  if (actor.state === "queued" || actor.state === "waiting") return actor.waitReason ?? (actor.state === "queued" ? "Waiting for a turn" : "Ready for a message");
  if (actor.state === "completed") return "Finished";
  if (actor.state === "cancelled") return "Stopped";
  if (blocks.some((block) => block.kind === "approval" && !block.decision)) return "Needs your input";
  const active = blocks.findLast(
    (block) =>
      (block.kind === "tool" && !block.done) ||
      (block.kind === "thinking" && block.endedAt === null) ||
      (block.kind === "activity" && block.status === "running") ||
      (block.kind === "message" && block.streaming),
  );
  if (active?.kind === "tool") return `Running ${active.name.replace(/^.*[.]/, "").replaceAll("_", " ")}`;
  if (active?.kind === "thinking") return "Thinking…";
  if (active?.kind === "activity") return active.label;
  if (active?.kind === "message") return "Writing…";
  return "Working…";
}

import type { TeamActorRecord, TeamMailboxMessage } from "@openorc/protocol";
/** Addressed lead work wins, then subtree owners; ambient readers take the last free slot. */
export function schedulingPriority({
  actor,
  pending,
  actors,
}: {
  actor: Pick<TeamActorRecord, "id" | "participant" | "ambient">;
  pending: readonly Pick<TeamMailboxMessage, "senderId">[];
  actors: readonly Pick<TeamActorRecord, "parentId" | "participant">[];
}): number {
  if (actor.id === "lead" && pending.some((message) => message.senderId === "user")) return -1;
  if (actor.ambient && pending.length === 0) return 3;
  if (actor.id === "lead") return 0;
  if (actor.participant || actors.some((child) => child.parentId === actor.id && !child.participant)) return 1;
  return 2;
}

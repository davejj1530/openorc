import type { TeamConversation, TeamExecutionView } from "@openorc/protocol";
import { readDraft, writeDraft } from "./drafts";

export type TeamContextCheckpoint = NonNullable<TeamConversation["context"]>["checkpoints"][number];
export type TeamWorkspaceRestore = NonNullable<TeamConversation["workspaceRestores"]>[number];
export type TeamWorkspaceMove = NonNullable<TeamConversation["workspaceMoves"]>[number];
export type TeamContextHistoryItem =
  | { kind: "execution"; execution: TeamExecutionView }
  | { kind: "checkpoint"; checkpoint: TeamContextCheckpoint }
  | { kind: "restore"; restore: TeamWorkspaceRestore }
  | { kind: "move"; move: TeamWorkspaceMove };

function historyCreatedAt(item: TeamContextHistoryItem): number {
  switch (item.kind) {
    case "execution":
      return item.execution.createdAt;
    case "checkpoint":
      return item.checkpoint.createdAt;
    case "restore":
      return item.restore.createdAt;
    case "move":
      return item.move.createdAt;
  }
}

/** A compacted lead session sits between executions; actor recovery stays with its assignment. */
export function teamContextHistory(
  executions: TeamExecutionView[],
  checkpoints: TeamContextCheckpoint[] = [],
  restores: TeamWorkspaceRestore[] = [],
  moves: TeamWorkspaceMove[] = [],
): TeamContextHistoryItem[] {
  const order = { checkpoint: 0, restore: 1, move: 2, execution: 3 };
  return [
    ...executions.map((execution) => ({ kind: "execution" as const, execution })),
    ...checkpoints.filter((checkpoint) => checkpoint.reason === "compact").map((checkpoint) => ({ kind: "checkpoint" as const, checkpoint })),
    ...restores.map((restore) => ({ kind: "restore" as const, restore })),
    ...moves.map((move) => ({ kind: "move" as const, move })),
  ].sort((a, b) => {
    const at = historyCreatedAt(a);
    const bt = historyCreatedAt(b);
    return at - bt || order[a.kind] - order[b.kind];
  });
}

export function actorContextCheckpoints(checkpoints: TeamContextCheckpoint[], executionId: string, actorId: string): TeamContextCheckpoint[] {
  return checkpoints
    .filter((checkpoint) => checkpoint.reason === "fresh_retry" && checkpoint.executionId === executionId && checkpoint.actorId === actorId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function readTeamContextRequest(storageKey: string): string | null {
  const value = readDraft<{ requestKey?: unknown }>(storageKey, {});
  return typeof value.requestKey === "string" && value.requestKey.length > 0 && value.requestKey.length <= 200 ? value.requestKey : null;
}

/** Persist before calling the server. An uncertain reply must replay the same action after reload. */
export function beginTeamContextRequest(storageKey: string, pendingKey?: string | null): string {
  const storedKey = readTeamContextRequest(storageKey);
  // A different view may have confirmed this action and begun another one.
  // Confirm the old identity without overwriting that newer recovery record.
  if (pendingKey && storedKey && pendingKey !== storedKey) return pendingKey;
  const requestKey = pendingKey ?? storedKey ?? crypto.randomUUID();
  if (!writeDraft(storageKey, { requestKey })) throw new Error("Could not save this context request for recovery. Retry when local storage is available.");
  return requestKey;
}

export function finishTeamContextRequest(storageKey: string, requestKey: string): boolean {
  const storedKey = readTeamContextRequest(storageKey);
  return Boolean(storedKey && storedKey !== requestKey) || writeDraft(storageKey, {});
}

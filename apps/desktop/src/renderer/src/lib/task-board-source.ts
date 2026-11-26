import { useMemo, useState } from "react";
import type { BoardColumn } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "./client";
import type { BoardSlot } from "./task-board";
import { useTaskProjects } from "./task-list-source";
import { useTaskOnlineMutation, useTaskOnlineQuery, useTaskOnlineScope, type TaskOnlineScope } from "./task-online-query";

/**
 * Whose columns a project's board shows: this computer's, for a project in a folder here, or its organization's, kept on
 * the server and shared by everyone who works on its tasks. A task of the other kind sits in its board by its status.
 */
export type BoardOwner = { place: "local"; projectId: string } | { place: "online"; scope: TaskOnlineScope; projectId: string; key: string };

/** The project a board belongs to, as the app's project list names it. */
export const boardProjectKey = (owner: BoardOwner): string => (owner.place === "local" ? owner.projectId : owner.key);

/** An organization project's shared board, when its server keeps boards. A Personal space's projects keep none. */
export function useSharedBoard(projectKey: string | null): BoardOwner | null {
  const { scope, availability } = useTaskOnlineScope();
  const keeps = scope && !scope.personal && availability?.board ? scope : null;
  const projects = useTaskProjects(keeps);
  const hosted = projectKey ? (projects.data?.find((project) => project.key === projectKey)?.hostedProjectId ?? null) : null;
  const accountId = keeps?.accountId,
    spaceId = keeps?.spaceId;
  return useMemo(
    () => (accountId && spaceId && hosted && projectKey ? { place: "online", scope: { accountId, spaceId }, projectId: hosted, key: projectKey } : null),
    [accountId, spaceId, hosted, projectKey],
  );
}

const CHANGED = "This board changed while you were editing it. It shows the latest columns now, so make your change again.";

/** Why the last save failed, or, after one lost to another person's, that the board now shows theirs. */
function saveNotice(error: Error | null, lost: boolean): { text: string; failed: boolean } | null {
  if (error) return { text: `Couldn’t save the board: ${error.message}`, failed: true };
  return lost ? { text: CHANGED, failed: false } : null;
}

/** The columns of the owner's board as read so far; none without an owner, so the board is its statuses. */
function boardColumnsOf(owner: BoardOwner | null, local: readonly BoardColumn[] | undefined, shared: readonly BoardColumn[] | undefined): readonly BoardColumn[] | undefined {
  if (!owner) return [];
  return owner.place === "local" ? local : shared;
}

/** The columns `owner` keeps, and their save: the whole board each time, from the revision read when it is shared. */
export function useBoardColumns(owner: BoardOwner | null) {
  const local = owner?.place === "local" ? owner.projectId : null;
  const online = owner?.place === "online" ? owner : null;
  const kept = useRpc("board.columns", { projectId: local ?? "" }, { enabled: Boolean(local) });
  const shared = useTaskOnlineQuery(online?.scope ?? null, "tasks.online.board", { spaceId: online?.scope.spaceId ?? "", projectId: online?.projectId ?? "" });
  const saveLocal = useRpcMutation("board.saveColumns");
  const saveShared = useTaskOnlineMutation(online?.scope ?? null, "tasks.online.saveBoard");
  // A save that lost to another one reloads the board, since a conflict refreshes it as a save does, and says so.
  const [lost, setLost] = useState(false);
  const columns = boardColumnsOf(owner, kept.data, shared.data?.columns);
  const revision = shared.data?.revision;
  const save = (next: BoardSlot[]) => {
    setLost(false);
    if (local) saveLocal.mutate({ projectId: local, columns: next });
    else if (online && revision !== undefined)
      saveShared.mutate(
        { spaceId: online.scope.spaceId, projectId: online.projectId, requestId: crypto.randomUUID(), ifRevision: revision, columns: next },
        { onSuccess: (result) => setLost(result.state === "conflict") },
      );
  };
  const saving = local ? saveLocal : saveShared;
  return {
    columns,
    /** Whether the person may change the board's columns now: this computer's, or a shared one read with leave to change it. */
    editable: Boolean(local || (online && shared.data?.mayEdit)),
    save,
    saving: saving.isPending,
    notice: saveNotice(saving.error, lost),
  };
}

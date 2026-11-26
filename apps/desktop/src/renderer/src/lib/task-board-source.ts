import { useCallback, useMemo, useState } from "react";
import { BOARD_COLUMNS_MAX, type BoardColumn, type Project } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "./client";
import { boardSlots, taskBoardColumns, type BoardKeeper, type BoardSlot, type TaskBoardColumn } from "./task-board";
import { boardsFull, boardUnion, projectBoards, unionBoardColumns, unionChange, unionSlots, type UnionColumn } from "./task-board-union";
import type { TaskRecord } from "./task-records";
import { useTaskProjects } from "./task-list-source";
import { useTeamUnionBoard, type TeamUnionOwner } from "./task-board-team-union";
import { useTaskOnlineMutation, useTaskOnlineQuery, useTaskOnlineScope, type TaskOnlineScope } from "./task-online-query";

/**
 * Whose columns a project's board shows: this computer's, for a project in a folder here, or its organization's, kept on
 * the server and shared by everyone who works on its tasks. A task of the other kind sits in its board by its status.
 */
export type BoardOwner =
  | { place: "local"; projectId: string }
  /** `runs`: its server runs the columns' agents, on the computer of each task's assignee. */
  | { place: "online"; scope: TaskOnlineScope; projectId: string; key: string; runs: boolean }
  /** Every project with a folder on this computer, whose columns the board of all projects shows as their union. */
  | { place: "union"; projectIds: readonly string[] }
  /** Every project of an organization whose server keeps boards, whose shared columns its board of all projects shows as their union. */
  | TeamUnionOwner;

/** Which kind of task the owner's columns hold: an organization's, or this computer's. */
export const boardKeeper = (owner: BoardOwner | null): BoardKeeper => (owner?.place === "online" || owner?.place === "team-union" ? "online" : "local");

/** Whether the owner's columns can have agents: this computer's always, an organization's where its server runs them. */
export function columnAgents(owner: BoardOwner | null): boolean {
  if (owner?.place === "online" || owner?.place === "team-union") return owner.runs;
  return true;
}

/** The project a board belongs to, as the app's project list names it; none for the board of all projects. */
export function boardProjectKey(owner: BoardOwner): string | null {
  if (owner.place === "local") return owner.projectId;
  return owner.place === "online" ? owner.key : null;
}

/**
 * An organization project's shared board, when its server keeps boards; with no project named, the union of all its
 * projects' boards. A Personal space's projects keep none.
 */
export function useSharedBoard(projectKey: string | null): BoardOwner | null {
  const { scope, availability } = useTaskOnlineScope();
  const keeps = scope && !scope.personal && availability?.board ? scope : null;
  const projects = useTaskProjects(keeps);
  const accountId = keeps?.accountId,
    spaceId = keeps?.spaceId;
  const runs = Boolean(availability?.runs);
  return useMemo<BoardOwner | null>(() => {
    if (!accountId || !spaceId || !projects.data) return null;
    if (!projectKey) {
      const hosted = projects.data.filter((project) => project.hostedProjectId);
      const names = new Map(hosted.map((project) => [project.hostedProjectId!, project.name]));
      return { place: "team-union", scope: { accountId, spaceId }, projectIds: hosted.map((project) => project.hostedProjectId!), names, runs };
    }
    const hosted = projects.data.find((project) => project.key === projectKey)?.hostedProjectId;
    return hosted ? { place: "online", scope: { accountId, spaceId }, projectId: hosted, key: projectKey, runs } : null;
  }, [accountId, spaceId, projects.data, projectKey, runs]);
}

/**
 * The board a task list shows: one project's, shared by its organization when the server keeps boards, else kept with
 * its folder on this computer; or, on all projects, the union of an organization's shared boards, or outside one of
 * every project here. `localProject` is the one project kept here, which also keeps its automations.
 */
export function useBoardOwner(projectId: string | null, projects: readonly Project[] | undefined, organization: boolean): { owner: BoardOwner | null; localProject: string | null } {
  const shared = useSharedBoard(projectId);
  const local = shared ? null : (projects?.find((project) => project.id === projectId && project.rootPath)?.id ?? null);
  const union = useMemo<BoardOwner | null>(
    () => (projectId || organization || !projects ? null : { place: "union", projectIds: projects.filter((project) => project.rootPath).map((project) => project.id) }),
    [projectId, organization, projects],
  );
  const owner = useMemo<BoardOwner | null>(() => shared ?? (local ? { place: "local", projectId: local } : union), [shared, local, union]);
  return { owner, localProject: local };
}

const CHANGED = "This board changed while you were editing it. It shows the latest columns now, so make your change again.";

/** Why the last save failed, or, after one lost to another person's, that the board now shows theirs. */
function saveNotice(error: Error | null, lost: boolean): { text: string; failed: boolean } | null {
  if (error) return { text: `Couldn’t save the board: ${error.message}`, failed: true };
  return lost ? { text: CHANGED, failed: false } : null;
}

/** A board's columns as the board draws and changes them, whoever keeps them. */
export type BoardSource = {
  /** Whether the board's columns are read, so a column's settings can open on them. */
  ready: boolean;
  slots: BoardSlot[];
  columnsFor: (tasks: readonly TaskRecord[]) => TaskBoardColumn[];
  /** On the board of all projects, each column's union: which projects have it, and where its agent differs. */
  union: UnionColumn[] | null;
  /** Whether the person may change the board's columns now: this computer's, or a shared one read with leave to change it. */
  editable: boolean;
  /** Whether no column can be added: the board has as many as one can, or on the board of all projects, every project's has. */
  full: boolean;
  save: (next: BoardSlot[]) => void;
  saving: boolean;
  notice: { text: string; failed: boolean } | null;
};

/**
 * The board of all projects: the union of every project's columns, and its save, which changes each project's own
 * board that the change reaches, one after another.
 */
function useUnionBoard(owner: Extract<BoardOwner, { place: "union" }> | null): BoardSource {
  const all = useRpc("board.allColumns", {}, { enabled: Boolean(owner) });
  const save = useRpcMutation("board.saveColumns");
  const [state, setState] = useState<{ saving: boolean; error: Error | null }>({ saving: false, error: null });
  const boards = useMemo(() => (owner ? projectBoards(owner.projectIds, all.data ?? []) : []), [owner, all.data]);
  const union = useMemo(() => boardUnion(boards), [boards]);
  const slots = useMemo(() => unionSlots(union), [union]);
  const columnsFor = useCallback((tasks: readonly TaskRecord[]) => unionBoardColumns(tasks, union, boards), [union, boards]);
  const run = async (next: BoardSlot[]) => {
    setState({ saving: true, error: null });
    try {
      for (const board of unionChange(union, next, boards)) await save.mutateAsync({ projectId: board.projectId, columns: board.slots });
      setState({ saving: false, error: null });
    } catch (error) {
      setState({ saving: false, error: error instanceof Error ? error : new Error(String(error)) });
    }
  };
  return {
    ready: all.data !== undefined,
    slots,
    columnsFor,
    union,
    editable: true,
    full: boardsFull(boards),
    save: (next) => void run(next),
    saving: state.saving,
    notice: saveNotice(state.error, false),
  };
}

const NO_COLUMNS: readonly BoardColumn[] = [];

/** The columns of the owner's board as read so far; none without an owner, so the board is its statuses. */
function boardColumnsOf(owner: BoardOwner | null, local: readonly BoardColumn[] | undefined, shared: readonly BoardColumn[] | undefined): readonly BoardColumn[] | undefined {
  if (!owner) return NO_COLUMNS;
  return owner.place === "local" ? local : shared;
}

/**
 * One project's board: this computer's columns, or its organization's, saved whole each time from the revision read.
 * Without an owner the board is its statuses and changes nothing.
 */
function useProjectBoard(owner: Extract<BoardOwner, { place: "local" | "online" }> | null): BoardSource {
  const local = owner?.place === "local" ? owner.projectId : null;
  const online = owner?.place === "online" ? owner : null;
  const kept = useRpc("board.columns", { projectId: local ?? "" }, { enabled: Boolean(local) });
  const shared = useTaskOnlineQuery(online?.scope ?? null, "tasks.online.board", { spaceId: online?.scope.spaceId ?? "", projectId: online?.projectId ?? "" });
  const saveLocal = useRpcMutation("board.saveColumns");
  const saveShared = useTaskOnlineMutation(online?.scope ?? null, "tasks.online.saveBoard");
  // A save that lost to another one reloads the board, since a conflict refreshes it as a save does, and says so.
  const [lost, setLost] = useState(false);
  const keeper: BoardKeeper = online ? "online" : "local";
  const columns = boardColumnsOf(owner, kept.data, shared.data?.columns);
  const slots = useMemo(() => boardSlots(columns ?? []), [columns]);
  const columnsFor = useCallback((tasks: readonly TaskRecord[]) => taskBoardColumns(tasks, columns, keeper), [columns, keeper]);
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
    ready: columns !== undefined,
    slots,
    columnsFor,
    union: null,
    editable: Boolean(local || (online && shared.data?.mayEdit)),
    full: slots.length >= BOARD_COLUMNS_MAX,
    save,
    saving: saving.isPending,
    notice: saveNotice(saving.error, lost),
  };
}

/** The columns `owner` keeps, as the board draws them, and their save. */
export function useBoardColumns(owner: BoardOwner | null): BoardSource {
  const union = useUnionBoard(owner?.place === "union" ? owner : null);
  const team = useTeamUnionBoard(owner?.place === "team-union" ? owner : null);
  const project = useProjectBoard(owner?.place === "local" || owner?.place === "online" ? owner : null);
  if (owner?.place === "union") return union;
  return owner?.place === "team-union" ? team : project;
}

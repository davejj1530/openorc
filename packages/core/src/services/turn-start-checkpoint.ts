import { realpath } from "node:fs/promises";
import { checkpoints, orchestration, runs, type Db } from "@openorc/db";
import { diffStat, pinObject, treeHash } from "@openorc/git";
import type { Project, Thread, ThreadCheckpoint } from "@openorc/protocol";
import { checkpointRefs } from "./checkpoint-refs.js";
import { projectGit } from "./project-git.js";
import { working, type LiveRun } from "./run-types.js";
import { treeChanges } from "./tree-changes.js";
import { overlaps } from "./workspace-writers.js";
import type { Logger } from "../transport.js";

/** Files that changed since the conversation's last checkpoint, found as a turn started. */
export interface OutsideChanges {
  /** The row that splits these changes off the agent's turn, or null in a folder without git. */
  checkpointId: string | null;
  by: "user" | "unknown";
  /** Added, changed or deleted, relative to the folder, sorted. */
  paths: string[];
}

export interface TurnStart {
  thread: Thread;
  /** The project as the run sees it (executionProject), for git state. */
  project: Project;
  /** The folder the run holds its lease on. */
  cwd: string;
  /** Team turns are captured by the coordinator. */
  team: boolean;
}

interface Dependencies {
  db: Db;
  log: Logger;
  /** The transcript draws the new row's line as soon as the turn starts, not when it ends. */
  invalidate: (keys: string[]) => void;
  /** Live runs, to see whether another conversation is working in the folder right now. */
  live: ReadonlyMap<string, LiveRun>;
  /** Folder-relative paths the editor saved under a root since a time. */
  editorSaves: (root: string, since: number) => string[];
}

/** At most this many paths are named in the prompt; the rest are counted. */
const NOTE_PATHS = 30;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Saves the folder as each turn begins, under the run's lease, after the prompt is recorded and before the provider
 * receives it, so nothing of the new turn can be in the tree. Files that changed since the thread's last checkpoint
 * get a row of their own, which the next turn's card and Undo count from, whoever changed them: the editor, a
 * terminal, an outside editor or another conversation. Each thread keeps its own chain; no thread writes another's.
 *
 * A row is `user` only when no agent could have made the changes and the editor saved every changed path. Otherwise
 * it is `unknown`: a false "You changed" would show someone else's work as the user's, a false neutral line only
 * reads less personal. Folders without git have no rows; the agent still hears which files the editor saved since
 * the thread's last turn start.
 */
export class TurnStartCapture {
  /** When each thread last started a turn in a folder without git. Lost on restart, like the journal it is read against. */
  private readonly starts = new Map<string, number>();

  constructor(private readonly deps: Dependencies) {}

  /** Null when nothing changed, on a first turn (its "Starting files" row is saved instead), and for a team's folder. */
  async capture(start: TurnStart): Promise<OutsideChanges | null> {
    const { thread, project, cwd } = start;
    if (start.team || orchestration.getInstance(this.deps.db, thread.id)) return null;
    if ((await projectGit(project)) === "none") return this.withoutGit(thread.id, await realpath(cwd));
    const last = checkpoints.listForThread(this.deps.db, thread.id).at(-1);
    if (!last) {
      await this.captureStartingFiles(thread, cwd);
      return null;
    }
    // Splitting outside changes off the coming turn is best effort: a failure costs the split, never the user's message.
    return this.captureChanges(thread, project, cwd, last).catch((error: unknown) => {
      this.deps.log.warn(`Could not save the files changed between turns of ${thread.id}: ${message(error)}`);
      return null;
    });
  }

  /** Turn zero: the working files before the first provider can edit them, so the first turn has a diff and an Undo. */
  private async captureStartingFiles(thread: Thread, cwd: string): Promise<void> {
    try {
      const [tree, stat, root] = await Promise.all([treeHash(cwd), diffStat(cwd, thread.baseSha), realpath(cwd)]);
      await pinObject(cwd, `${checkpointRefs(thread.id)}${tree}`, tree);
      checkpoints.insert(this.deps.db, { threadId: thread.id, runId: null, turn: 0, treeSha: tree, diffStat: stat, root, note: "Starting files" });
    } catch (error) {
      throw new Error(`Could not save the starting files for Undo: ${message(error)}`, { cause: error });
    }
  }

  private async captureChanges(thread: Thread, project: Project, cwd: string, last: ThreadCheckpoint): Promise<OutsideChanges | null> {
    const [tree, root] = await Promise.all([treeHash(cwd), realpath(cwd)]);
    // A thread that moved folders, or a row saved before roots were recorded, has nothing comparable here.
    if (tree === last.treeSha || last.root !== root) return null;
    const paths = (await treeChanges(project.rootPath, last.treeSha, tree)).files.map((file) => file.path).sort();
    const by = this.attribute(thread, root, last.createdAt, paths);
    await pinObject(cwd, `${checkpointRefs(thread.id)}${tree}`, tree);
    const note = by === "user" ? "Your changes" : "Changes between turns";
    const row = checkpoints.insert(this.deps.db, { threadId: thread.id, runId: null, turn: last.turn, treeSha: tree, diffStat: await diffStat(cwd, thread.baseSha), root, note, outside: by });
    this.deps.invalidate([`checkpoints:${thread.id}`]);
    return { checkpointId: row.id, by, paths };
  }

  /** `user` only when no agent could have touched the folder since `since` and the editor saved every changed path. */
  private attribute(thread: Thread, root: string, since: number, paths: string[]): OutsideChanges["by"] {
    if (checkpoints.agentWorkSince(this.deps.db, { root, threadId: thread.id, since })) return "unknown";
    // A run of this thread that died mid-turn left its edits without a checkpoint.
    if (runs.listForThread(this.deps.db, thread.id).some((run) => run.endedAt !== null && run.endedAt >= since && run.state !== "success")) return "unknown";
    for (const entry of this.deps.live.values()) {
      if (entry.scope.thread?.id !== thread.id && !entry.scope.comment && working(entry) && overlaps(entry.workspaceLease.paths, [root])) return "unknown";
    }
    const saved = new Set<string>(this.deps.editorSaves(root, since));
    return paths.every((path) => saved.has(path)) ? "user" : "unknown";
  }

  /** No git means no rows; the agent still hears about the files the editor saved since this thread's last turn start. */
  private withoutGit(threadId: string, root: string): OutsideChanges | null {
    const since = this.starts.get(threadId);
    this.starts.set(threadId, Date.now());
    if (since === undefined) return null;
    const paths = this.deps.editorSaves(root, since).sort();
    return paths.length ? { checkpointId: null, by: "user", paths } : null;
  }
}

/** The note the agent's prompt carries this turn. Never shown in the transcript. */
export function outsideChangesNote({ by, paths }: OutsideChanges): string {
  const named = paths.slice(0, NOTE_PATHS).join(", ");
  const rest = paths.length > NOTE_PATHS ? ` and ${paths.length - NOTE_PATHS} more` : "";
  const who = by === "user" ? "the user changed these files" : "these files changed outside your turns, by the user or another agent";
  return `Since your last turn, ${who}: ${named}${rest}. Read them again before editing them.`;
}

/** What the provider receives: the prompt, then the note. The transcript records the prompt alone. */
export function withOutsideNote(prompt: string, changes: OutsideChanges | null): string {
  return changes && changes.paths.length ? `${prompt}\n\n${outsideChangesNote(changes)}` : prompt;
}

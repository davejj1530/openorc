import { realpath } from "node:fs/promises";
import { projects, tasks, teamDeletedThreads, teamRuntime, threads, type Db } from "@openorc/db";
import { WORKSPACE_ID, type ConversationScope, type Project, type Task, type Thread } from "@openorc/protocol";
import { inUnvettedCopy } from "./review-copies.js";
import { directory, executionProject, workspaceHome } from "./workspace-home.js";

/** What kind of folder a conversation works in. It decides who may edit there. */
export type FolderKind = "checkout" | "worktree" | "workspace" | "review" | "member";

export interface ConversationFolder {
  /** Real path, symlinks resolved. File paths are checked against it, and caches are keyed by it. */
  readonly root: string;
  readonly kind: FolderKind;
  /** The project as the run sees it. A Workspace conversation's carries its own folder. */
  readonly project: Project;
  /** Why files here can't be edited, or null. */
  readonly readOnly: string | null;
}

/** Who a run works for, as run launch holds it. A comment run has neither and works in the project root it is given. */
export interface ExecutionScope {
  thread: Pick<Thread, "worktreePath"> | null;
  task: Pick<Task, "workspaceMode" | "worktreePath"> | null;
}

/** A search scope, or a Workspace conversation's chosen folder before the conversation exists, as skills.list asks. */
export type FolderScope = ConversationScope | { kind: "project"; id: string; workingDirectory?: string | undefined };

/**
 * Where a run for this scope works, given the project as the run sees it: a task in "current" mode in the project
 * root even if it once had a worktree, any other task in its worktree, a thread in its worktree, else the root. A
 * Workspace thread's root is its chosen folder (executionProject).
 */
export function executionFolder({ task, thread }: ExecutionScope, project: Pick<Project, "rootPath">): string {
  if (task?.workspaceMode === "current") return project.rootPath;
  if (task) return task.worktreePath ?? project.rootPath;
  return thread?.worktreePath ?? project.rootPath;
}

/** A conversation's folder, resolved the way its next run resolves it. Throws when the conversation, its project or its folder is gone. */
export async function conversationFolder(db: Db, scope: FolderScope): Promise<ConversationFolder> {
  if (scope.kind === "project") return projectFolder(db, scope.id, scope.workingDirectory);
  if (scope.kind === "thread") {
    const thread = threads.get(db, scope.id);
    if (!thread) throw new Error(`thread ${scope.id} not found`);
    return threadFolder(db, thread);
  }
  const task = tasks.get(db, scope.id);
  if (!task) throw new Error(`task ${scope.id} not found`);
  return taskFolder(db, task);
}

async function threadFolder(db: Db, thread: Thread): Promise<ConversationFolder> {
  const project = executionProject(db, thread);
  const kind = threadKind(db, thread, project);
  const readOnly = editBlocker(kind) ?? (teamDeletedThreads.has(db, thread.id) ? "This conversation was deleted." : null);
  return { root: await folderRoot(executionFolder({ thread, task: null }, project)), kind, project, readOnly };
}

function threadKind(db: Db, thread: Thread, project: Project): FolderKind {
  if (project.id === WORKSPACE_ID) return "workspace";
  if (inUnvettedCopy(db, thread)) return "review";
  return thread.worktreePath ? "worktree" : "checkout";
}

/** Task runs launch with the raw project row, so a task resolves against it, not against executionProject. */
async function taskFolder(db: Db, task: Task): Promise<ConversationFolder> {
  const member = teamRuntime.assignmentForTask(db, task.id) !== null;
  if (!member && task.executionThreadId) {
    // A task started in a conversation runs there, as that conversation's own turn.
    const thread = threads.get(db, task.executionThreadId);
    if (!thread) throw new Error("This task's conversation was deleted.");
    return threadFolder(db, thread);
  }
  const project = projects.get(db, task.projectId);
  if (!project) throw new Error(`project ${task.projectId} not found`);
  const kind = taskKind(task, project, member);
  return { root: await folderRoot(executionFolder({ task, thread: null }, project)), kind, project, readOnly: editBlocker(kind) };
}

function taskKind(task: Task, project: Project, member: boolean): FolderKind {
  if (member) return "member";
  if (project.id === WORKSPACE_ID) return "workspace";
  return task.workspaceMode !== "current" && task.worktreePath ? "worktree" : "checkout";
}

/** A project's checkout before any conversation exists. Only a Workspace conversation may choose its own folder. */
async function projectFolder(db: Db, id: string, workingDirectory: string | undefined): Promise<ConversationFolder> {
  const home = id === WORKSPACE_ID ? workspaceHome(db) : projects.get(db, id);
  if (!home) throw new Error(`project ${id} not found`);
  if (workingDirectory && home.id !== WORKSPACE_ID) throw new Error("Only Workspace conversations can choose a working folder.");
  const project = workingDirectory ? { ...home, rootPath: await directory(workingDirectory) } : home;
  return { root: await folderRoot(project.rootPath), kind: project.id === WORKSPACE_ID ? "workspace" : "checkout", project, readOnly: null };
}

async function folderRoot(folder: string): Promise<string> {
  return realpath(folder).catch(() => {
    throw new Error(`${folder} is missing. It may have been moved or deleted.`);
  });
}

/**
 * A pull request copy is someone else's code under review, and a team member's copy is an agent's work in progress,
 * which reaches the user's folder only through integration.
 */
function editBlocker(kind: FolderKind): string | null {
  if (kind === "review") return "Pull request copies are read-only.";
  return kind === "member" ? "Team member copies are read-only." : null;
}

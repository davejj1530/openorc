import { lstat, realpath, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { projects, settings, threads, type Db } from "@openorc/db";
import { WORKSPACE_ID, type Project, type Thread } from "@openorc/protocol";

/** The existing ownership table also holds one explicit personal scope. It is
 * excluded from repository discovery and never receives Git setup or cleanup. */
export async function ensureWorkspaceHome(db: Db, dataDir: string): Promise<void> {
  const root = path.join(dataDir, "workspace");
  await mkdir(root, { recursive: true });
  db.stmt("INSERT OR IGNORE INTO projects (id,name,root_path,git_remote,default_branch,settings,created_at,updated_at) VALUES (?, 'Workspace', ?, NULL, NULL, '{}', ?, ?)").run(
    WORKSPACE_ID,
    root,
    Date.now(),
    Date.now(),
  );
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export async function directory(value: string, { create = false }: { create?: boolean } = {}): Promise<string> {
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) throw new Error("Choose an absolute folder path.");
  if (create) {
    await mkdir(expanded, { recursive: true }).catch(() => {
      throw new Error("This folder could not be created.");
    });
  }
  const resolved = await realpath(expanded).catch(() => {
    throw new Error("This folder does not exist or is unavailable.");
  });
  if (!(await stat(resolved)).isDirectory()) throw new Error("Choose a folder, not a file.");
  return resolved;
}

export async function folderMissing(value: string): Promise<boolean> {
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) return false;
  return lstat(expanded).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
}

export function workspaceHome(db: Db): Project {
  const home = projects.get(db, WORKSPACE_ID);
  if (!home) throw new Error("Workspace is not initialized.");
  return { ...home, rootPath: settings.get(db, "workspace.entrypoint") ?? home.rootPath };
}

export function executionProject(db: Db, thread: Pick<Thread, "projectId" | "workingDirectory">): Project {
  const project = thread.projectId === WORKSPACE_ID ? workspaceHome(db) : projects.get(db, thread.projectId);
  if (!project) throw new Error("This conversation's project is unavailable.");
  return project.id === WORKSPACE_ID && thread.workingDirectory ? { ...project, rootPath: thread.workingDirectory } : project;
}

export async function configureWorkspace(db: Db, entrypoint: string): Promise<Project> {
  const root = await directory(entrypoint);
  settings.set(db, "workspace.entrypoint", root);
  return workspaceHome(db);
}

/** Forks share their parent's worktree; it goes only with the last thread that uses it. */
export function worktreeShared(db: Db, thread: Thread): boolean {
  if (!thread.worktreePath) return false;
  return threads.list(db, { projectId: thread.projectId, filter: "all" }).some((t) => t.id !== thread.id && t.worktreePath === thread.worktreePath);
}

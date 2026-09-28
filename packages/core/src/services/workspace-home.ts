import { realpath, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { projects, settings, type Db } from "@openorc/db";
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

export async function directory(value: string): Promise<string> {
  let expanded = value;
  if (value === "~") expanded = os.homedir();
  else if (value.startsWith("~/")) expanded = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(expanded)) throw new Error("Choose an absolute folder path.");
  const resolved = await realpath(expanded).catch(() => {
    throw new Error("This folder does not exist or is unavailable.");
  });
  if (!(await stat(resolved)).isDirectory()) throw new Error("Choose a folder, not a file.");
  return resolved;
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

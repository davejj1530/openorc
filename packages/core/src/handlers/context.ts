import { audit, Db, memories, orchestration, projects, tasks, teamRuntime, threads } from "@openorc/db";
import { access } from "node:fs/promises";
import { FolderPath } from "@openorc/protocol";
import { conversationFolder } from "../services/conversation-folder.js";
import type { FileService } from "../services/files.js";
import { executionProject } from "../services/workspace-home.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function threadAndProject(db: Db, threadId: string) {
  const thread = threads.get(db, threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);
  const project = executionProject(db, thread);
  return { thread, project };
}

export function taskAndProject(db: Db, taskId: string) {
  const task = tasks.get(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const project = projects.get(db, task.projectId);
  if (!project) throw new Error(`project ${task.projectId} not found`);
  return { task, project };
}

export async function reviewWorkspace(db: Db, taskId: string) {
  const { task, project } = taskAndProject(db, taskId);
  const unprepared = !task.baseSha || (task.workspaceMode === "worktree" && (!task.worktreePath || !(await pathExists(task.worktreePath))));
  const teamOwned = teamRuntime.assignmentForTask(db, task.id) || (task.threadId && orchestration.getInstance(db, task.threadId));
  if (unprepared && teamOwned) throw new Error("This team workspace is not ready for review. Wait for its assignment to start.");
  return { task, project };
}

/**
 * Adds a memory to the project's instruction file through the editor's versioned write: the file is read with its
 * version and written back only while still the same, so an edit made meanwhile is never overwritten. It skips
 * formatting, which would restyle the rest of the user's file.
 */
export async function promoteMemory(deps: { db: Db; files: Pick<FileService, "read" | "write"> }, id: string, file: "CLAUDE.md" | "AGENTS.md"): Promise<{ file: string }> {
  const { db } = deps;
  const memory = memories.get(db, id);
  if (!memory || !memory.projectId) throw new Error("memory not found");
  const folder = await conversationFolder(db, { kind: "project", id: memory.projectId });
  const path = FolderPath.parse(file);
  const current = await deps.files.read(folder, path);
  if (current.kind === "unreadable") throw new Error(`${file} can't be edited here: ${current.reason}`);
  const header = "## Project memory (from OpenOrc)";
  const bullet = `- ${memory.title}: ${memory.body}`;
  const content = current.kind === "file" ? current.text : "";
  if (content.includes(bullet)) return { file };
  const text = content.includes(header) ? content.replace(header, `${header}\n${bullet}`) : `${content.trimEnd()}\n\n${header}\n${bullet}\n`.trimStart();
  const expected = current.kind === "file" ? { kind: "version" as const, version: current.version } : { kind: "absent" as const };
  const saved = await deps.files.write(folder, { path, text, expected, format: false });
  if (saved.kind === "conflict") throw new Error(`${file} changed while the memory was being added. Try again.`);
  audit.record(db, { actor: "user", action: "memory.promote", resourceType: "memory", resourceId: id, metadata: { file } });
  return { file };
}

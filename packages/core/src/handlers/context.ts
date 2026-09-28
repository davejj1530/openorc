import { audit, Db, memories, orchestration, projects, tasks, teamRuntime, threads } from "@openorc/db";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

export async function promoteMemory(db: Db, id: string, file: "CLAUDE.md" | "AGENTS.md"): Promise<{ file: string }> {
  const memory = memories.get(db, id);
  if (!memory || !memory.projectId) throw new Error("memory not found");
  const project = projects.get(db, memory.projectId);
  if (!project) throw new Error("project not found");
  const target = path.join(project.rootPath, file);
  const header = "## Project memory (from OpenOrc)";
  const bullet = `- ${memory.title}: ${memory.body}`;
  let content = "";
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    // A failed read is not an empty file: preserve user instructions on
    // permission and I/O errors instead of replacing them with this memory.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (content.includes(bullet)) return { file };
  if (content.includes(header)) {
    content = content.replace(header, `${header}\n${bullet}`);
  } else {
    content = `${content.trimEnd()}\n\n${header}\n${bullet}\n`.trimStart();
  }
  await writeFile(target, content);
  audit.record(db, { actor: "user", action: "memory.promote", resourceType: "memory", resourceId: id, metadata: { file } });
  return { file };
}

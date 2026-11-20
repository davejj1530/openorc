import { threads, type Db } from "@openorc/db";
import { executionModeUnavailable, harnessIds, modelEfforts, type CommentRecipient, type ModelOption, type Orcling, type Project, type Task } from "@openorc/protocol";
import { access } from "node:fs/promises";
import type { RunService } from "./runs.js";

export async function recipientCatalog(runService: Pick<RunService, "models">): Promise<ModelOption[]> {
  const results = await Promise.allSettled(harnessIds.map((agent) => runService.models(agent)));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export function validateRecipient(recipient: CommentRecipient, catalog: ModelOption[]): void {
  const unavailable = executionModeUnavailable(recipient.agent, "plan");
  if (unavailable) throw new Error(unavailable);
  const model = catalog.find((m) => m.agent === recipient.agent && m.id === recipient.model);
  if (!model || model.unavailable) throw new Error(model?.unavailable ?? `Model ${recipient.model} is unavailable. Choose another recipient.`);
  const efforts = modelEfforts(recipient.agent, recipient.model, model.efforts);
  if (recipient.effort !== null && !efforts.includes(recipient.effort)) throw new Error(`Unsupported effort for ${model.label}.`);
}

/** An Orcling replies with its current model, whatever an older reply recorded. */
export function asOrcling(recipient: CommentRecipient, everyOrcling: Orcling[]): CommentRecipient {
  if (!recipient.orclingId) return recipient;
  const orcling = everyOrcling.find((o) => o.id === recipient.orclingId);
  if (!orcling) throw new Error("That Orcling no longer exists. Mention another agent.");
  return { agent: orcling.settings.agent, model: orcling.settings.model, effort: orcling.settings.effort, orclingId: orcling.id };
}

/**
 * Where a run about a task reads: its thread's worktree, else the task's, else its thread's folder, else the project's.
 * A worktree removed since, as by cleanup, leaves the project folder.
 */
export async function taskSideRunFolder(db: Db, task: Task, project: Project): Promise<string> {
  const ownerId = task.executionThreadId || task.threadId;
  const owner = ownerId ? threads.get(db, ownerId) : null;
  const folder = owner?.worktreePath ?? task.worktreePath ?? owner?.workingDirectory ?? project.rootPath;
  if (folder === project.rootPath) return folder;
  return access(folder).then(
    () => folder,
    () => project.rootPath,
  );
}

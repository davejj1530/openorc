import type { OnlineTaskRef, OnlineTaskThread, OnlineTaskThreadDraft } from "@openorc/protocol";

export interface TaskComposerDraft {
  text: string;
  attachments: number;
}
export interface TaskDraftStage {
  text: string;
  task: OnlineTaskThreadDraft;
}

export function stageTaskDraft(previous: OnlineTaskThreadDraft | null, reference: OnlineTaskRef, prepared: OnlineTaskThread, draft: TaskComposerDraft, requestId: string): TaskDraftStage {
  const { task } = prepared;
  if (task.id !== reference.id || task.spaceId !== reference.spaceId || task.projectId !== reference.projectId) throw new Error("This task isn't available.");
  if (samePreparation(previous, reference, prepared)) return { text: draft.text, task: previous };
  const inserted = draft.text.length === 0 && draft.attachments === 0;
  return {
    text: inserted ? prepared.draft : draft.text,
    task: { reference, threadId: prepared.threadId, ifRevision: task.revision, prompt: prepared.draft, inserted, requestId },
  };
}
export function insertTaskDraft(task: OnlineTaskThreadDraft, text: string): TaskDraftStage {
  if (task.inserted) return { task, text };
  return { text: text ? `${text}\n\n${task.prompt}` : task.prompt, task: { ...task, inserted: true } };
}
function samePreparation(previous: OnlineTaskThreadDraft | null, reference: OnlineTaskRef, prepared: OnlineTaskThread): previous is OnlineTaskThreadDraft {
  if (!previous || previous.threadId !== prepared.threadId || previous.ifRevision !== prepared.task.revision) return false;
  return (
    previous.reference.accountId === reference.accountId &&
    previous.reference.spaceId === reference.spaceId &&
    previous.reference.projectId === reference.projectId &&
    previous.reference.id === reference.id
  );
}

import { OnlineTaskThreadDraft, type OnlineTaskRef, type OnlineTaskThread } from "@openorc/protocol";
import { readDraft, writeDraft } from "./drafts";
import { insertTaskDraft, stageTaskDraft } from "./task-thread-draft";

export interface HostedTaskDraftScope {
  apiOrigin: string;
  accountId: string;
  spaceId: string;
}
type StoredDraft = { text: string; task?: OnlineTaskThreadDraft };
const listeners = new Map<string, Set<() => void>>();

export function hostedConversationDraftKey(scope: HostedTaskDraftScope, threadId: string): string {
  return `conversation.online:${JSON.stringify([scope.accountId, scope.spaceId, threadId, new URL(scope.apiOrigin).origin])}`;
}
export function preparedTaskDraft(key: string): OnlineTaskThreadDraft | null {
  const data = readDraft<{ task?: unknown }>(key, {});
  const parsed = OnlineTaskThreadDraft.safeParse(data.task);
  return parsed.success ? parsed.data : null;
}
export function preparedTaskFor(scope: HostedTaskDraftScope, threadId: string): OnlineTaskThreadDraft | null {
  const task = preparedTaskDraft(hostedConversationDraftKey(scope, threadId));
  return task?.threadId === threadId && task.reference.accountId === scope.accountId && task.reference.spaceId === scope.spaceId ? task : null;
}
export function stageStoredTask(scope: HostedTaskDraftScope, reference: OnlineTaskRef, prepared: OnlineTaskThread, attachments = 0): string {
  if (scope.accountId !== reference.accountId || scope.spaceId !== reference.spaceId) throw new Error("This task isn't available.");
  const key = hostedConversationDraftKey(scope, prepared.threadId);
  const current = storedDraft(key);
  const files = readDraft<{ attachments: unknown }>(`${key}.attachments`, { attachments: [] });
  const count = Math.max(attachments, Array.isArray(files.attachments) ? files.attachments.length : 1);
  const staged = stageTaskDraft(current.task ?? null, reference, prepared, { text: current.text, attachments: count }, crypto.randomUUID());
  save(key, staged);
  return key;
}
export function insertStoredTask(key: string, expected: OnlineTaskThreadDraft, text: string): string {
  const current = preparedTaskDraft(key);
  if (current?.requestId !== expected.requestId) throw new Error("This prepared task changed. Open the menu again.");
  const inserted = insertTaskDraft(current, text);
  save(key, inserted);
  return inserted.text;
}
export function acceptStoredTask(key: string, expected: OnlineTaskThreadDraft, submitted: string): string | null {
  const current = storedDraft(key);
  if (current.task?.requestId !== expected.requestId) return null;
  const text = current.text === submitted ? "" : current.text;
  save(key, { text });
  return text;
}
export function subscribeTaskDraft(key: string, change: () => void): () => void {
  const group = listeners.get(key) ?? new Set<() => void>();
  group.add(change);
  listeners.set(key, group);
  const storage = (event: StorageEvent) => {
    if (event.key === `openorc.draft.${key}`) change();
  };
  window.addEventListener("storage", storage);
  return () => {
    group.delete(change);
    if (!group.size) listeners.delete(key);
    window.removeEventListener("storage", storage);
  };
}
export function taskDraftSnapshot(key: string): string | null {
  try {
    return localStorage.getItem(`openorc.draft.${key}`);
  } catch {
    return null;
  }
}
function storedDraft(key: string): StoredDraft {
  const saved = readDraft<{ text: unknown }>(key, { text: "" });
  if (typeof saved.text !== "string") throw new Error("This draft couldn't be read.");
  const task = preparedTaskDraft(key);
  return { text: saved.text, ...(task ? { task } : {}) };
}
function save(key: string, draft: StoredDraft): void {
  if (!writeDraft(key, draft)) throw new Error("This draft couldn't be saved on this device.");
  for (const change of listeners.get(key) ?? []) change();
}

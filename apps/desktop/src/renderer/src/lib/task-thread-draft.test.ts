import { expect, it } from "vitest";
import type { OnlineTaskThread } from "@openorc/protocol";
import { insertTaskDraft, stageTaskDraft } from "./task-thread-draft";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const prepared = (): OnlineTaskThread => ({ accessRevision: 1, task: onlineTask(), threadId: "shared-thread", created: true, draft: "Implement the saved task.\n\nKeep the current behavior." });
const stage = (text = "", attachments = 0) => stageTaskDraft(null, onlineReference, prepared(), { text, attachments }, crypto.randomUUID());

it("fills an empty composer without starting work", () => {
  const draft = stage();
  expect(draft.text).toBe(prepared().draft);
  expect(draft.task).toMatchObject({ reference: onlineReference, threadId: "shared-thread", ifRevision: prepared().task.revision, inserted: true });
});
it("keeps existing words and files with a pending insertion", () => {
  expect(stage("My words", 2)).toMatchObject({ text: "My words", task: { inserted: false } });
  expect(stage("", 1)).toMatchObject({ text: "", task: { inserted: false } });
});
it("appends a pending task once and keeps the captured send identity", () => {
  const draft = stage("My words", 1);
  const inserted = insertTaskDraft(draft.task, draft.text);
  expect(inserted.text).toBe(`My words\n\n${prepared().draft}`);
  expect(inserted.task).toEqual({ ...draft.task, inserted: true });
  expect(insertTaskDraft(inserted.task, inserted.text)).toEqual(inserted);
});
it("reopening the same document preserves later edits and does not repeat insertion", () => {
  const draft = stage();
  const reopened = stageTaskDraft(draft.task, onlineReference, prepared(), { text: "My later edits", attachments: 1 }, crypto.randomUUID());
  expect(reopened).toEqual({ text: "My later edits", task: draft.task });
});
it("an explicitly reopened changed document keeps words and captures its newly read revision", () => {
  const draft = stage();
  const next = prepared();
  next.task.revision++;
  next.draft = "A changed document";
  const reopened = stageTaskDraft(draft.task, onlineReference, next, { text: "My edited message", attachments: 0 }, crypto.randomUUID());
  expect(reopened.text).toBe("My edited message");
  expect(reopened.task).toMatchObject({ ifRevision: next.task.revision, prompt: next.draft, inserted: false });
  expect(reopened.task.requestId).not.toBe(draft.task.requestId);
});
it("never accepts a preparation that changed its task, space or project", () => {
  for (const patch of [{ id: "another-task" }, { spaceId: "another-space" }, { projectId: "another-project" }]) {
    const next = prepared();
    Object.assign(next.task, patch);
    expect(() => stageTaskDraft(null, onlineReference, next, { text: "Keep me", attachments: 0 }, crypto.randomUUID())).toThrow("isn't available");
  }
});

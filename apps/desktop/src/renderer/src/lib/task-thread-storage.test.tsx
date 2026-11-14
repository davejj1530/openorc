import { afterEach, expect, it } from "vitest";
import { acceptStoredTask, hostedConversationDraftKey, insertStoredTask, preparedTaskDraft, preparedTaskFor, stageStoredTask } from "./task-thread-storage";
import { readDraft, writeDraft } from "./drafts";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const scope = { apiOrigin: "https://example.com", accountId: onlineReference.accountId, spaceId: onlineReference.spaceId };
const prepared = () => ({ accessRevision: 1, task: onlineTask(), threadId: "carrying-thread", created: true, draft: "A saved task prompt" });
const key = hostedConversationDraftKey(scope, "carrying-thread");
afterEach(() => localStorage.clear());

it("keeps the scope's text and task context in one durable draft and leaves its files intact", () => {
  writeDraft(key, { text: "Existing words" });
  writeDraft(`${key}.attachments`, { attachments: [{ path: "attachment-one", name: "notes.txt" }] });
  expect(stageStoredTask(scope, onlineReference, prepared())).toBe(key);
  expect(readDraft(key, { text: "" })).toMatchObject({ text: "Existing words", task: { inserted: false } });
  const task = preparedTaskDraft(key)!;
  expect(insertStoredTask(key, task, "Existing words")).toBe("Existing words\n\nA saved task prompt");
  expect(insertStoredTask(key, preparedTaskDraft(key)!, "Existing words\n\nA saved task prompt")).toBe("Existing words\n\nA saved task prompt");
  expect(readDraft(`${key}.attachments`, { attachments: [] }).attachments).toHaveLength(1);
});
it("never reads another API, account, space or legacy conversation draft", () => {
  writeDraft("conversation.carrying-thread", { text: "Legacy words" });
  const own = stageStoredTask(scope, onlineReference, prepared());
  expect(readDraft(own, { text: "" }).text).toBe(prepared().draft);
  for (const patch of [{ apiOrigin: "https://other.example.com" }, { accountId: "another-account" }, { spaceId: "another-space" }]) {
    expect(preparedTaskDraft(hostedConversationDraftKey({ ...scope, ...patch }, "carrying-thread"))).toBeNull();
  }
  expect(readDraft("conversation.carrying-thread", { text: "" }).text).toBe("Legacy words");
});
it("accepting a sent task clears only that captured draft and preserves later words", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const task = preparedTaskDraft(key)!;
  writeDraft(key, { text: "Later words", task });
  expect(acceptStoredTask(key, task, prepared().draft)).toBe("Later words");
  expect(readDraft(key, { text: "" })).toEqual({ text: "Later words" });
});
it("an older accepted send cannot clear a newly prepared task", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const previous = preparedTaskDraft(key)!;
  const next = prepared();
  next.task.revision++;
  stageStoredTask(scope, onlineReference, next);
  const current = preparedTaskDraft(key);
  expect(acceptStoredTask(key, previous, previous.prompt)).toBeNull();
  expect(preparedTaskDraft(key)).toEqual(current);
});
it("refuses stored routing metadata that names another account or thread", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const task = preparedTaskDraft(key)!;
  for (const patch of [{ reference: { ...task.reference, accountId: "another-account" } }, { threadId: "another-thread" }]) {
    writeDraft(key, { text: "My words", task: { ...task, ...patch } });
    expect(preparedTaskFor(scope, "carrying-thread")).toBeNull();
  }
});

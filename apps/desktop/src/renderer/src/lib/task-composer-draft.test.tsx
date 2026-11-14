import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostedFileScope } from "@openorc/protocol";
import { useConversationDraft } from "./conversation-draft";
import { useTaskComposerDraft } from "./task-composer-draft";
import { hostedConversationDraftKey, preparedTaskDraft, stageStoredTask } from "./task-thread-storage";
import { readDraft, writeDraft } from "./drafts";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const gate = vi.hoisted(() => ({ allowed: true }));
vi.mock("./organization-content-gate", () => ({ organizationContentGate: { capture: () => ({ current: () => gate.allowed }) } }));
vi.mock("./client", () => ({ useRpcMutation: () => ({ mutate: vi.fn(), error: null }) }));
const threadId = "carrying-thread";
const scope: HostedFileScope = {
  apiOrigin: "https://example.com",
  accountId: onlineReference.accountId,
  spaceId: onlineReference.spaceId,
  destination: { kind: "hosted", projectId: onlineReference.projectId, threadId },
};
const key = hostedConversationDraftKey(scope, threadId);
const prepared = () => ({ accessRevision: 1, task: onlineTask(), threadId, created: true, draft: "Task prompt" });
const mount = () =>
  renderHook(() => {
    const draft = useConversationDraft({ draftKey: key, threadId: null, initialText: "" });
    const task = useTaskComposerDraft({ scope, threadId, draftKey: key, prompt: draft.prompt, setPrompt: draft.setPrompt });
    return { draft, task };
  });
afterEach(() => {
  cleanup();
  localStorage.clear();
  gate.allowed = true;
});

it("preserves pending task context through typing and inserts its prompt only once", () => {
  writeDraft(key, { text: "My words" });
  stageStoredTask(scope, onlineReference, prepared());
  const hook = mount();
  act(() => hook.result.current.draft.setPrompt("My newer words"));
  expect(hook.result.current.task.task?.context).toEqual({ id: onlineReference.id, ifRevision: 1 });
  expect(hook.result.current.task.insert).toBeTypeOf("function");
  act(() => hook.result.current.task.insert?.());
  expect(hook.result.current.draft.prompt).toBe("My newer words\n\nTask prompt");
  expect(hook.result.current.task.insert).toBeUndefined();
  expect(preparedTaskDraft(key)?.inserted).toBe(true);
});
it("hears preparation in an already mounted empty composer without calling ready or Send", () => {
  const hook = mount();
  act(() => {
    stageStoredTask(scope, onlineReference, prepared());
  });
  expect(hook.result.current.draft.prompt).toBe("Task prompt");
  expect(hook.result.current.task.prepared).toBe(true);
  expect(hook.result.current.task.insert).toBeUndefined();
});
it("clears only the accepted task and keeps typing that happened during its send", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const hook = mount();
  const sent = hook.result.current.task;
  act(() => hook.result.current.draft.setPrompt("Next words"));
  act(() => expect(sent.accepted("Task prompt")).toBe(true));
  expect(hook.result.current.draft.prompt).toBe("Next words");
  expect(preparedTaskDraft(key)).toBeNull();
});
it("never resurrects a removed draft when an old send finishes after account access changes", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const hook = mount();
  const sent = hook.result.current.task;
  gate.allowed = false;
  localStorage.clear();
  act(() => expect(sent.accepted("Task prompt")).toBe(true));
  expect(readDraft(key, { text: "absent" }).text).toBe("absent");
});
it("blocks prepared metadata belonging to another project instead of sending without task context", () => {
  stageStoredTask(scope, onlineReference, prepared());
  const task = preparedTaskDraft(key)!;
  writeDraft(key, { text: "My words", task: { ...task, reference: { ...task.reference, projectId: "another-project" } } });
  const hook = mount();
  expect(hook.result.current.task.blocked).toBeTruthy();
  expect(hook.result.current.task.task).toBeUndefined();
});

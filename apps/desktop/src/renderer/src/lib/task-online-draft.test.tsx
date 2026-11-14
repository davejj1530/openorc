import { act, cleanup, renderHook } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTaskDraftBarrier, readTaskDraft } from "./task-draft";
import { useTaskDocumentDraft } from "./task-document-draft";
import { TaskSaveController } from "./task-save-conflict";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";
import { taskRefKey } from "./task-ref";

const localSave = vi.hoisted(() => vi.fn());
let actions: ReturnType<typeof createTaskDraftBarrier>;
vi.mock("./client", () => ({ useRpcMutation: () => ({ mutateAsync: localSave, isPending: false, error: null }) }));
vi.mock("./task-draft-context", () => ({ useTaskDraftActions: () => actions }));
const storageId = taskRefKey(onlineReference);
function useOnlineDraft(controller: TaskSaveController) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const document = useTaskDocumentDraft(state.task, { storageId, save: { mutateAsync: ({ patch }) => controller.save(patch), isPending: state.saving, error: state.error } });
  return { document, state };
}
beforeEach(() => {
  localStorage.clear();
  localSave.mockClear();
  actions = createTaskDraftBarrier(storageId, async () => {
    throw new Error("No document source");
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps the same 800ms autosave while storing online words separately from a Mac task with the same id", async () => {
  vi.useFakeTimers();
  localStorage.setItem(`openorc.draft.task.${onlineReference.id}`, JSON.stringify({ title: "Local", spec: "Private local words", labels: "" }));
  const send = vi.fn().mockResolvedValue({ state: "saved", accessRevision: 1, task: onlineTask({ revision: 2, spec: "Shared words" }) });
  const controller = new TaskSaveController(onlineReference, onlineTask(), send);
  const view = renderHook(() => useOnlineDraft(controller));
  act(() => view.result.current.document.patch({ spec: "Shared words" }));
  expect(readTaskDraft(storageId)?.spec).toBe("Shared words");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(799);
  });
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(readTaskDraft(onlineReference.id)?.spec).toBe("Private local words");
  expect(localSave).not.toHaveBeenCalled();
});

it("stops autosave after a conflict and replaces words only on Use saved version", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue({ state: "conflict", accessRevision: 1, task: onlineTask({ revision: 2, spec: "Teammate words" }) });
  const controller = new TaskSaveController(onlineReference, onlineTask(), send);
  const view = renderHook(() => useOnlineDraft(controller));
  act(() => view.result.current.document.patch({ spec: "My words" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(view.result.current.document.draft.spec).toBe("My words");
  act(() => view.result.current.document.patch({ spec: "My newest words" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(readTaskDraft(storageId)?.spec).toBe("My newest words");
  act(() => view.result.current.document.replaceSaved(controller.useSavedVersion()));
  expect(view.result.current.document.draft.spec).toBe("Teammate words");
  expect(view.result.current.document.dirty).toBe(false);
  expect(readTaskDraft(storageId)).toBeNull();
  expect(localSave).not.toHaveBeenCalled();
});

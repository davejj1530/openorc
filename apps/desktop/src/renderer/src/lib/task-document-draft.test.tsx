import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTaskDraftBarrier, readTaskDraft } from "./task-draft";
import { useTaskDocumentDraft } from "./task-document-draft";

const mutation = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false, error: null as Error | null }));
let actions: ReturnType<typeof createTaskDraftBarrier>;
vi.mock("./query", () => ({ useRpcMutation: () => mutation }));
vi.mock("./task-draft-context", () => ({ useTaskDraftActions: () => actions }));
const task = { id: "task", title: "Task", spec: "saved", labels: [] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear();
  mutation.mutateAsync.mockReset().mockResolvedValue(undefined);
  mutation.isPending = false;
  mutation.error = null;
  actions = createTaskDraftBarrier(task.id, async () => {
    throw new Error("Expected the registered Overview draft");
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("waits for the editor before saving and retains the last keystroke when navigation closes Overview", async () => {
  const images = deferred();
  const saving = deferred();
  mutation.mutateAsync.mockImplementationOnce(() => saving.promise);
  const view = renderHook(() => useTaskDocumentDraft(task));
  act(() => {
    view.result.current.patch({ spec: "before image completion" });
    view.result.current.reportImagesReady(false);
    view.result.current.body.current = {
      focus: () => {},
      flush: async () => {
        await images.promise;
        return true;
      },
    };
  });
  let navigation!: Promise<boolean>;
  act(() => {
    navigation = view.result.current.flush();
  });
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
  act(() => {
    view.result.current.patch({ spec: "image ready" });
    view.result.current.reportImagesReady(true);
    images.resolve();
  });
  await waitFor(() => expect(mutation.mutateAsync).toHaveBeenCalledTimes(1));
  act(() => view.result.current.patch({ spec: "final keystroke" }));
  view.unmount();
  saving.resolve();
  expect(await navigation).toBe(true);
  expect(mutation.mutateAsync.mock.calls.map(([input]) => input.patch.spec)).toEqual(["image ready", "final keystroke"]);
  expect(readTaskDraft(task.id)).toBeNull();
});

it("keeps a failed draft and refuses an unmounted pending image until a reopened editor can recover it", async () => {
  const first = renderHook(() => useTaskDocumentDraft(task));
  mutation.mutateAsync.mockRejectedValueOnce(new Error("Offline"));
  act(() => first.result.current.patch({ spec: "recover me" }));
  await act(async () => {
    expect(await first.result.current.flush()).toBe(false);
  });
  expect(first.result.current.error).toBe("Offline");
  expect(readTaskDraft(task.id)?.spec).toBe("recover me");
  act(() => first.result.current.reportImagesReady(false));
  first.unmount();
  await expect(actions.flushTaskDraft(task.id)).rejects.toThrow("Open Overview to retry");
  expect(mutation.mutateAsync).toHaveBeenCalledTimes(1);
  const reopened = renderHook(() => useTaskDocumentDraft(task));
  expect(reopened.result.current.draft.spec).toBe("recover me");
  await act(async () => {
    expect(await reopened.result.current.flush()).toBe(true);
  });
  expect(readTaskDraft(task.id)).toBeNull();
});

it("accepts idle external revisions without restoring stale server content after a local save", async () => {
  const { result, rerender } = renderHook((input) => useTaskDocumentDraft(input), { initialProps: task });
  rerender({ ...task, spec: "external first" });
  expect(result.current.draft.spec).toBe("external first");
  act(() => result.current.patch({ spec: "local edit" }));
  rerender({ ...task, spec: "external while dirty" });
  expect(result.current.draft.spec).toBe("local edit");
  await act(async () => {
    expect(await result.current.flush()).toBe(true);
  });
  expect(result.current.draft.spec).toBe("local edit");
  expect(result.current.dirty).toBe(false);
  rerender({ ...task, spec: "external after save" });
  expect(result.current.draft.spec).toBe("external after save");
});

it("applies a deferred external revision when local edits are reverted without saving", () => {
  const { result, rerender, unmount } = renderHook((input) => useTaskDocumentDraft(input), { initialProps: task });
  act(() => result.current.patch({ spec: "local edit" }));
  rerender({ ...task, spec: "external while dirty" });
  expect(result.current.draft.spec).toBe("local edit");
  act(() => result.current.patch({ spec: task.spec }));
  expect(result.current.draft.spec).toBe("external while dirty");
  expect(result.current.dirty).toBe(false);
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
  expect(readTaskDraft(task.id)).toBeNull();
  unmount();
  const reopened = renderHook(() => useTaskDocumentDraft({ ...task, spec: "external while dirty" }));
  expect(reopened.result.current.draft.spec).toBe("external while dirty");
});

it("cancels autosave on navigation but keeps an in-memory draft when local storage fails", async () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => useTaskDocumentDraft(task));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  act(() => result.current.patch({ spec: "only in memory" }));
  expect(result.current.draftStored).toBe(false);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mutation.mutateAsync).not.toHaveBeenCalled();
  await actions.flushTaskDraft(task.id);
  expect(mutation.mutateAsync).toHaveBeenCalledWith({ id: task.id, patch: { title: "Task", spec: "only in memory", labels: [] } });
});

it("keeps the draft being typed when the server returns its own save trimmed", async () => {
  const { result, rerender } = renderHook((input) => useTaskDocumentDraft(input), { initialProps: { ...task, labels: [] as string[] } });
  act(() => result.current.patch({ spec: "Keep typing ", labels: "bug,review" }));
  await act(async () => {
    expect(await result.current.flush()).toBe(true);
  });
  expect(mutation.mutateAsync).toHaveBeenCalledWith({ id: task.id, patch: { title: "Task", spec: "Keep typing", labels: ["bug", "review"] } });
  rerender({ ...task, spec: "Keep typing", labels: ["bug", "review"] });
  expect(result.current.draft).toEqual({ title: "Task", spec: "Keep typing ", labels: "bug,review" });
  expect(result.current.dirty).toBe(false);
});

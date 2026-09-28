import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeTaskDraft, createTaskDraftBarrier, readTaskDraft, sameTaskDraft, taskDraftPatch, type TaskDocumentDraft } from "./task-draft";

const draft = (spec: string): TaskDocumentDraft => ({ title: "Task", spec, labels: "bug, bug, review" });
const key = "openorc.draft.task.task";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("task action draft barrier", () => {
  it("waits for images and saves keystrokes made during an earlier save before releasing any action", async () => {
    const images = deferred();
    const firstSave = deferred();
    let current = draft("![pending](openorc-pending://image)");
    let saved = draft("old spec");
    const savedSpecs: string[] = [];
    const barrier = createTaskDraftBarrier("task", async () => {
      throw new Error("Should use the mounted editor");
    });
    barrier.register({
      prepare: async () => {
        await images.promise;
      },
      read: () => (sameTaskDraft(current, saved) ? null : { ...current }),
      save: async (value) => {
        savedSpecs.push(value.spec);
        if (savedSpecs.length === 1) await firstSave.promise;
      },
      acknowledge: (value) => {
        saved = value;
      },
    });
    const autosave = barrier.flushTaskDraft("task");
    const start = barrier.flushTaskDraft("task");
    expect(start).toBe(autosave);
    expect(savedSpecs).toEqual([]);
    current = draft("![ready](openorc-image://saved) after image import");
    images.resolve();
    await vi.waitFor(() => expect(savedSpecs).toHaveLength(1));
    current = draft("Final keystroke and ![ready](openorc-image://saved)");
    let released = false;
    void start.then(() => {
      released = true;
    });
    expect(released).toBe(false);
    firstSave.resolve();
    await start;
    expect(savedSpecs).toEqual(["![ready](openorc-image://saved) after image import", current.spec]);
    expect(saved).toEqual(current);
  });

  it("keeps an unmounted failed-save draft and retries it instead of launching the server's stale spec", async () => {
    localStorage.setItem(key, JSON.stringify(draft("unsaved local instructions")));
    const save = vi.fn().mockRejectedValueOnce(new Error("Save unavailable")).mockResolvedValue(undefined);
    const barrier = createTaskDraftBarrier("task", save);
    await expect(barrier.flushTaskDraft("task")).rejects.toThrow("Save unavailable");
    expect(readTaskDraft("task")?.spec).toBe("unsaved local instructions");
    await barrier.flushTaskDraft("task");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].spec).toBe("unsaved local instructions");
    expect(readTaskDraft("task")).toBeNull();
  });

  it("blocks image-pending and malformed durable drafts without removing them or saving a partial spec", async () => {
    const save = vi.fn();
    const barrier = createTaskDraftBarrier("task", save);
    const pending = JSON.stringify(draft("![image](openorc-pending://import-id)"));
    localStorage.setItem(key, pending);
    await expect(barrier.flushTaskDraft("task")).rejects.toThrow("image has not saved");
    expect(localStorage.getItem(key)).toBe(pending);
    localStorage.setItem(key, '{"spec":false}');
    await expect(barrier.flushTaskDraft("task")).rejects.toThrow("draft could not be read");
    expect(localStorage.getItem(key)).toBe('{"spec":false}');
    expect(save).not.toHaveBeenCalled();
  });

  it("blocks an unresolved mounted image import even when no Markdown reference exists yet", async () => {
    const save = vi.fn();
    const barrier = createTaskDraftBarrier("task", save);
    barrier.register({
      prepare: async () => {
        throw new Error("Image import needs recovery");
      },
      read: () => draft("Text before the pasted bytes finished staging"),
      save,
      acknowledge: () => {},
    });
    await expect(barrier.flushTaskDraft("task")).rejects.toThrow("Image import needs recovery");
    expect(save).not.toHaveBeenCalled();
  });

  it("serializes a remounted editor behind the previous save and rejects actions for a different task", async () => {
    const previous = deferred();
    const writes: string[] = [];
    const barrier = createTaskDraftBarrier("task", async () => {});
    let oldDirty = true;
    barrier.register({
      prepare: async () => {},
      read: () => (oldDirty ? draft("old view") : null),
      save: async (value) => {
        writes.push(value.spec);
        await previous.promise;
      },
      acknowledge: () => {
        oldDirty = false;
      },
    });
    const action = barrier.flushTaskDraft("task");
    await vi.waitFor(() => expect(writes).toEqual(["old view"]));
    let newDirty = true;
    barrier.register({
      prepare: async () => {},
      read: () => (newDirty ? draft("new view") : null),
      save: async (value) => {
        writes.push(value.spec);
      },
      acknowledge: () => {
        newDirty = false;
      },
    });
    await expect(barrier.flushTaskDraft("different")).rejects.toThrow("task changed");
    expect(writes).toEqual(["old view"]);
    previous.resolve();
    await action;
    expect(writes).toEqual(["old view", "new view"]);
  });

  it("does not clear another window's newer draft when acknowledging a saved snapshot", async () => {
    const old = draft("saved snapshot");
    const newer = draft("newer local snapshot");
    localStorage.setItem(key, JSON.stringify(newer));
    acknowledgeTaskDraft("task", old);
    expect(readTaskDraft("task")).toEqual(newer);
    expect(taskDraftPatch(newer)).toEqual({ title: "Task", spec: newer.spec, labels: ["bug", "review"] });
  });
});

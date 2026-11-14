import { describe, expect, it, vi } from "vitest";
import type { OnlineTaskMutation, OnlineTaskParams } from "@openorc/protocol";
import { TaskSaveController } from "./task-save-conflict";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const words = { title: "My title", spec: "My unsaved words", labels: ["draft"] };
const saved = (revision: number): OnlineTaskMutation => ({ state: "saved", accessRevision: 1, task: onlineTask({ ...words, revision }) });
const conflict = (revision: number): OnlineTaskMutation => ({
  state: "conflict",
  accessRevision: 1,
  task: onlineTask({ title: "Teammate title", revision, updatedBy: { userId: "account-b", name: "Sam", image: null } }),
});

describe("online task document saves", () => {
  it("keeps words through two conflicts and requires another explicit choice", async () => {
    const send = vi.fn().mockResolvedValueOnce(conflict(2)).mockResolvedValueOnce(conflict(3)).mockResolvedValueOnce(saved(4));
    const controller = new TaskSaveController(onlineReference, onlineTask(), send);
    await expect(controller.save(words)).rejects.toThrow("changed");
    expect(words.spec).toBe("My unsaved words");
    expect(controller.getSnapshot().conflict?.updatedBy?.name).toBe("Sam");
    await expect(controller.save(words)).rejects.toThrow("Choose");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(controller.overwrite(words)).rejects.toThrow("changed");
    expect(controller.getSnapshot().conflict?.revision).toBe(3);
    await controller.overwrite(words);
    expect(send.mock.calls.map(([input]) => input.ifRevision)).toEqual([1, 2, 3]);
    expect(new Set(send.mock.calls.map(([input]) => input.requestId)).size).toBe(3);
    expect(controller.getSnapshot().conflict).toBeNull();
  });
  it("repeats a lost reply with the same id and body before sending newer words", async () => {
    const inputs: OnlineTaskParams<"tasks.online.update">[] = [];
    const send = vi.fn(async (input: OnlineTaskParams<"tasks.online.update">) => {
      inputs.push(input);
      if (inputs.length === 1) throw new Error("Connection lost");
      return saved(inputs.length);
    });
    const controller = new TaskSaveController(onlineReference, onlineTask(), send);
    await expect(controller.save(words)).rejects.toThrow("Connection lost");
    await controller.save({ ...words, spec: "Newer words" });
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]?.requestId).not.toBe(inputs[0]?.requestId);
    expect(inputs[2]?.patch.spec).toBe("Newer words");
    expect(inputs[2]?.ifRevision).toBe(2);
  });
  it("uses the saved version only after that explicit choice", async () => {
    const controller = new TaskSaveController(onlineReference, onlineTask(), vi.fn().mockResolvedValue(conflict(2)));
    await expect(controller.save(words)).rejects.toThrow();
    expect(controller.useSavedVersion()).toMatchObject({ title: "Teammate title", spec: "Saved words", labels: "" });
    expect(controller.getSnapshot().conflict).toBeNull();
  });
  it("refreshes a stale property without discarding an unrelated document conflict", async () => {
    const send = vi.fn().mockResolvedValueOnce(conflict(2)).mockResolvedValueOnce(conflict(3));
    const controller = new TaskSaveController(onlineReference, onlineTask(), send);
    await expect(controller.save(words)).rejects.toThrow();
    await controller.property({ priority: "high" });
    expect(controller.getSnapshot().task.revision).toBe(3);
    expect(controller.getSnapshot().propertyError).toContain("Choose again");
    expect(controller.getSnapshot().conflict).not.toBeNull();
  });
  it("rejects a different task or project instead of adopting it", () => {
    const controller = new TaskSaveController(onlineReference, onlineTask(), vi.fn());
    expect(() => controller.observe(onlineTask({ projectId: "project-b", revision: 99 }))).toThrow("changed");
    expect(controller.getSnapshot().task.projectId).toBe("project-a");
  });
});

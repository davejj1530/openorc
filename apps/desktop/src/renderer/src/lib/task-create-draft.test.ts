import { expect, it, vi } from "vitest";
import { TaskCreateDraft } from "./task-create-draft";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

const input = () => ({ spaceId: onlineReference.spaceId, projectId: onlineReference.projectId, title: "First words", requestId: crypto.randomUUID() });
it("replays a lost create reply before another draft can become a duplicate task", async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error("Lost reply")).mockResolvedValueOnce({ state: "saved", task: onlineTask(), accessRevision: 1 });
  const draft = new TaskCreateDraft(write);
  const original = input();
  await expect(draft.save(original)).rejects.toThrow("Lost reply");
  expect(draft.pending).toBe(true);
  await draft.save({ ...input(), title: "Later words" });
  expect(write.mock.calls.map(([request]) => request)).toEqual([original, original]);
  expect(draft.pending).toBe(false);
});
it("allows a corrected assignment after a definitive refusal", async () => {
  const write = vi
    .fn()
    .mockResolvedValueOnce({ state: "refused", code: "TASK_ASSIGNEE_UNAVAILABLE", message: "Choose another person." })
    .mockResolvedValueOnce({ state: "saved", task: onlineTask(), accessRevision: 1 });
  const draft = new TaskCreateDraft(write);
  await expect(draft.save(input())).rejects.toThrow("Choose another person");
  expect(draft.pending).toBe(false);
  const corrected = input();
  await draft.save(corrected);
  expect(write.mock.calls[1]?.[0]).toEqual(corrected);
});

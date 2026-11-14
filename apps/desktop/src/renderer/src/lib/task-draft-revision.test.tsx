import { beforeEach, expect, it } from "vitest";
import { TaskSaveController } from "./task-save-conflict";
import { keepTaskDraftRevision, recoveredTaskRevision } from "./task-draft-revision";
import { onlineReference, onlineTask } from "./test-fixtures/online-task";

beforeEach(() => localStorage.clear());
it("keeps a recovered document behind an explicit choice when its saved revision is stale or missing", () => {
  const task = onlineTask({ revision: 2 });
  localStorage.setItem("openorc.draft.task.scoped", JSON.stringify({ title: task.title, spec: "Kept words", labels: "" }));
  expect(recoveredTaskRevision("scoped", task)).toBeNull();
  keepTaskDraftRevision("scoped", 1);
  const controller = new TaskSaveController(
    onlineReference,
    task,
    async () => {
      throw new Error("Must not save automatically");
    },
    recoveredTaskRevision("scoped", task),
  );
  expect(controller.getSnapshot().conflict?.revision).toBe(2);
  expect(recoveredTaskRevision("another-account", task)).toBeUndefined();
});
it("does not report a lost successful save as a conflict when its words already match", () => {
  const task = onlineTask({ revision: 2 });
  localStorage.setItem("openorc.draft.task.scoped", JSON.stringify({ title: task.title, spec: task.spec, labels: "" }));
  keepTaskDraftRevision("scoped", 1);
  expect(recoveredTaskRevision("scoped", task)).toBeUndefined();
});

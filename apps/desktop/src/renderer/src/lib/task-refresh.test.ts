import { expect, it } from "vitest";
import { taskRefreshInterval } from "./task-refresh";
import { onlineTask } from "./test-fixtures/online-task";

it("refreshes visible live work promptly even when its task is Done", () => {
  const task = onlineTask({ status: "done" });
  task.viewer.liveExecution = true;
  expect(taskRefreshInterval({ accessRevision: 1, task })).toBe(3_000);
  expect(taskRefreshInterval({ accessRevision: 1, tasks: [task], cursor: null })).toBe(3_000);
});
it("leaves idle task and attention reads on the ordinary bounded cadence", () => {
  expect(taskRefreshInterval({ accessRevision: 1, task: onlineTask() })).toBe(30_000);
  expect(taskRefreshInterval({ accessRevision: 1, count: 0 })).toBe(30_000);
  expect(taskRefreshInterval(undefined)).toBe(30_000);
});

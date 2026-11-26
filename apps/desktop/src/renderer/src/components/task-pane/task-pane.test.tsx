import type { Task } from "@openorc/protocol";
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { taskRecordKey, type TaskRecord } from "../../lib/task-records";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { useOpenedTask } from "./task-pane";

const team: TaskRecord = { kind: "online", task: onlineTask({ id: "team-1" }), reference: { ...onlineReference, id: "team-1" }, project: undefined };
const own: TaskRecord = { kind: "local", task: { ...(onlineTask() as unknown as Task), id: "own-1", projectId: "p" } };

it("opens a team's task beside the board as it does one kept here, and closes once the board no longer holds it", () => {
  const { result, rerender } = renderHook(({ tasks }) => useOpenedTask(tasks), { initialProps: { tasks: [team, own] as TaskRecord[] } });
  act(() => result.current.toggle(taskRecordKey(team)));
  expect(result.current.record).toBe(team);
  // Only a task kept here leads the screen's own controls.
  expect(result.current.task).toBeNull();
  act(() => result.current.toggle(taskRecordKey(own)));
  expect(result.current.task?.id).toBe("own-1");
  act(() => result.current.toggle(taskRecordKey(team)));
  rerender({ tasks: [own] });
  expect(result.current.record).toBeNull();
});

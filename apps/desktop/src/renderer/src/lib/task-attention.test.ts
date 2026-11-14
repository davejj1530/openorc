import { expect, it } from "vitest";
import { onlineAttentionCount } from "./task-attention";
import { heldTaskGroups, taskGroups } from "./task-groups";
import { onlineTaskRecord } from "./task-records";
import { onlineTask } from "./test-fixtures/online-task";

it("counts the viewer's reasons once and ignores a teammate's review", () => {
  const waiting = onlineTask({ viewer: { ...onlineTask().viewer, attention: ["assignment", "review", "ask"], unseenAssignment: true } });
  expect(onlineAttentionCount([waiting, waiting, onlineTask({ id: "other", status: "review" })])).toBe(1);
});
it("holds the current groups during interaction without retaining revoked tasks", () => {
  const record = (id: string) => onlineTaskRecord(onlineTask({ id }), "account-a", [], []);
  const first = record("first"),
    second = record("second");
  const groups = taskGroups([first, second]);
  const moved = onlineTaskRecord(onlineTask({ id: "first", status: "review" }), "account-a", [], []);
  expect(heldTaskGroups(groups, [moved]).map((group) => [group.key, group.tasks.map((row) => row.task.id)])).toEqual([["backlog", ["first"]]]);
});

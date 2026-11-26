import { expect, it } from "vitest";
import { taskThreadPlace } from "./task-thread-place";
import { onlineTask } from "./test-fixtures/online-task";

it("opens a team task's thread where its work runs, else lets the person choose where", () => {
  const computer = (userId: string) => ({ userId, name: "Dana Lee", since: 1 });
  expect(taskThreadPlace(onlineTask({ computer: computer("me") }), "me", true)).toEqual({ kind: "here" });
  expect(taskThreadPlace(onlineTask({ computer: computer("dana") }), "me", true)).toEqual({ kind: "elsewhere", name: "Dana" });
  expect(taskThreadPlace(onlineTask({ execution: { state: "readable", threadId: "t", title: "Work" } }), "me", true)).toEqual({ kind: "cloud" });
  expect(taskThreadPlace(onlineTask({ execution: { state: "none" } }), "me", true)).toEqual({ kind: "choose" });
  // A server that opens no thread on a computer keeps its cloud thread.
  expect(taskThreadPlace(onlineTask({ execution: { state: "none" } }), "me", false)).toEqual({ kind: "cloud" });
});

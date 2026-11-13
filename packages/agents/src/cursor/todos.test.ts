import { expect, it } from "vitest";
import { CursorTodos } from "./todos.js";

it("merges Cursor checklist updates and replaces the list when requested", () => {
  const todos = new CursorTodos("run-1");
  todos.update({
    toolCallId: "a",
    merge: false,
    todos: [
      { id: "a", content: "Implement", status: "in_progress" },
      { id: "b", content: "Verify", status: "pending" },
    ],
  });
  expect(todos.update({ toolCallId: "b", merge: true, todos: [{ id: "a", content: "Implement", status: "completed" }] })).toMatchObject({ status: "running", text: "☑ Implement\n☐ Verify" });
  expect(todos.update({ toolCallId: "c", merge: true, todos: [{ id: "b", content: "Verify", status: "completed" }] })).toMatchObject({ status: "success", text: "☑ Implement\n☑ Verify" });
  expect(todos.update({ toolCallId: "d", merge: false, todos: [{ id: "c", content: "Next task", status: "pending" }] })).toMatchObject({ status: "running", text: "☐ Next task" });
});

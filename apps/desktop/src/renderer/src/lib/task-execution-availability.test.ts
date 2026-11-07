import { expect, it } from "vitest";
import { taskExecutionDisabledReason, type TaskExecutionAvailability } from "./task-execution-availability";

const editable: TaskExecutionAvailability = {
  loadFailed: false,
  loading: false,
  workspaceProject: false,
  savedTeam: false,
  sharedConversation: false,
  activeAgent: false,
  activeConversation: false,
};

it("allows moving an idle task and explains why saved teams and active work cannot move", () => {
  expect(taskExecutionDisabledReason(editable)).toBeNull();
  expect(taskExecutionDisabledReason({ ...editable, savedTeam: true })).toBe("This item is no longer available.");
  expect(taskExecutionDisabledReason({ ...editable, activeAgent: true })).toContain("Stop the task");
});

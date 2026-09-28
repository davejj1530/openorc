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
  handoffPreparing: false,
};

it("keeps task execution location reason priority across overlapping restrictions", () => {
  expect(taskExecutionDisabledReason({ ...editable, loadFailed: true, loading: true })).toBe("Could not load execution settings. Retry to continue.");
  expect(taskExecutionDisabledReason({ ...editable, loading: true, savedTeam: true })).toBe("Checking execution location…");
  expect(taskExecutionDisabledReason({ ...editable, workspaceProject: true, savedTeam: true })).toBe("This task uses its conversation’s folder.");
  expect(taskExecutionDisabledReason({ ...editable, savedTeam: true, sharedConversation: true })).toBe(
    "This task follows its saved team’s workspace policy. Delegated assignments keep their own workspaces.",
  );
  expect(taskExecutionDisabledReason({ ...editable, sharedConversation: true, activeAgent: true })).toBe(
    "This task shares its execution conversation. Use the conversation menu to move its workspace.",
  );
  expect(taskExecutionDisabledReason({ ...editable, activeAgent: true, activeConversation: true })).toBe("Stop the task’s existing agent in Activity before moving its workspace.");
  expect(taskExecutionDisabledReason({ ...editable, activeConversation: true, handoffPreparing: true })).toBe("Wait for the current turn to finish before moving this conversation.");
  expect(taskExecutionDisabledReason({ ...editable, handoffPreparing: true })).toBe("Finish the saved handoff before changing execution location.");
  expect(taskExecutionDisabledReason(editable)).toBeNull();
});

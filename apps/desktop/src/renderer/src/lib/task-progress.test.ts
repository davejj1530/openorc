import { describe, expect, it } from "vitest";
import { taskIdFromTool, taskActivity, taskCardStatusLabel } from "./task-progress";

describe("delegated task cards", () => {
  const id = "a9b0c758-cba7-4984-bf06-3b26342ccb6d";
  it.each(["mcp__openorc__task_start"])("shows live progress for %s", (name) => {
    expect(taskIdFromTool({ id: "call", kind: "tool", name, input: { id }, done: true, output: { content: [{ type: "text", text: JSON.stringify({ id, status: "in_progress" }) }] } })).toBe(id);
  });
  it("shows partial commentary and exposes an unresolved approval instead of a working label", () => {
    const message = { id: "m", kind: "message" as const, role: "assistant" as const, text: "I found the settings layout", streaming: true };
    const approval = { id: "a", kind: "approval" as const, approvalId: "a", approvalKind: "tool", toolName: "openorc.task_context", input: {} };
    expect(taskActivity([message, approval])).toMatchObject({ message, approval });
    expect(taskActivity([message, { ...approval, decision: "allow" }]).approval).toBeNull();
  });
  it("keeps the task card's approval, failure, cancellation and saved-status priority", () => {
    const label = (approvalKind?: string, runState?: "error" | "cancelled") => taskCardStatusLabel({ approvalKind, runState, taskLabel: "In progress" });
    expect(label("user_input", "error")).toBe("Needs your answer");
    expect(label("tool", "error")).toBe("Waiting for permission");
    expect(label(undefined, "error")).toBe("Run failed");
    expect(label(undefined, "cancelled")).toBe("Stopped");
    expect(label()).toBe("In progress");
  });
});

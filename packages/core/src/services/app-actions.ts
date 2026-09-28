import type { ExecutionMode } from "@openorc/protocol";

/**
 * OpenOrc's own tools that act beyond the conversation. Reading, searching, questions, and saving task documents
 * and plans are not actions: they change nothing outside OpenOrc's own records, so every mode allows them.
 */
export type AppAction = "browser_input" | "secret_input" | "memory_write" | "thread_message";
export type AppActionDecision = "allow" | "ask" | "block";

const permissiveness: Record<ExecutionMode, number> = { plan: 0, review: 1, trusted: 2, autonomous: 3 };

/**
 * What a mode does with an app action. Plan blocks every action, Review asks first, Accept edits asks for anything
 * outside the project, and Autonomous allows them. A password field asks in every mode but Plan. A message to another
 * conversation is only an action when that conversation works in a more permissive mode than the sender, because
 * it would do what the sender's mode does not allow.
 */
export function appActionPolicy(action: AppAction, mode: ExecutionMode, receiver?: ExecutionMode): AppActionDecision {
  if (action === "thread_message" && (!receiver || permissiveness[receiver] <= permissiveness[mode])) return "allow";
  if (mode === "plan") return "block";
  switch (action) {
    case "secret_input":
      return "ask";
    case "memory_write":
      return mode === "review" ? "ask" : "allow";
    case "browser_input":
    case "thread_message":
      return mode === "autonomous" ? "allow" : "ask";
  }
}

export const blockedInPlan: Record<AppAction, string> = {
  browser_input: "Clicking, typing and pressing keys in the Preview are blocked in Plan mode. Describe the steps in the plan instead.",
  secret_input: "Filling a password field is blocked in Plan mode.",
  memory_write: "Changing project memory is blocked in Plan mode. Put the finding in the plan instead.",
  thread_message: "In Plan mode, you can message only conversations that are also in Plan. Ask the user to send it.",
};

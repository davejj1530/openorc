import type { AgentEvent } from "@openorc/protocol";

/** An event as the demo writes it: the demo Mac stamps the run, the time and the id as it records it. */
export type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "runId" | "ts" | "eventId"> : never) : never;

/** What the person said. */
export const asked = (messageId: string, text: string): Draft => ({ type: "message.completed", messageId, role: "user", text });

/** What the agent said, whole. */
export const said = (messageId: string, text: string): Draft => ({ type: "message.completed", messageId, role: "assistant", text });

/** A call that started and finished, with what it gave back. */
export function called(toolCallId: string, name: string, input: unknown, output: unknown): Draft[] {
  return [
    { type: "tool.started", toolCallId, name, input, parentToolCallId: null },
    { type: "tool.completed", toolCallId, name, output, isError: false },
  ];
}

/** Claude reading a file, with the lines it read. */
export const readFile = (id: string, path: string, lines: string) => called(id, "Read", { file_path: path }, lines);

/** Claude searching the project. */
export const searched = (id: string, pattern: string, path: string, found: string) => called(id, "Grep", { pattern, path }, found);

/** Claude editing a file, and the change the Mac saw land. */
export function edited(id: string, path: string, before: string, after: string, diff: string): Draft[] {
  return [...called(id, "Edit", { file_path: path, old_string: before, new_string: after }, `The file ${path} has been updated.`), { type: "file.changed", path, kind: "modify", diff }];
}

/** A shell command, as Claude or Codex runs it. */
export const ran = (id: string, name: "Bash" | "commandExecution", command: string, output: string) => called(id, name, { command }, output);

/** A thought with its words, shown folded. */
export function thought(messageId: string, text: string): Draft[] {
  return [
    { type: "thinking.started", messageId },
    { type: "thinking.completed", messageId, text },
  ];
}

/** A finished turn: what was asked, the work, the answer. */
export function turn(turnId: string, question: string, work: Draft[], answer: string, durationMs: number): Draft[] {
  return [{ type: "turn.started", turnId }, asked(`${turnId}-ask`, question), ...work, said(`${turnId}-reply`, answer), { type: "turn.completed", turnId, status: "success", durationMs }];
}

import { describe, expect, it } from "vitest";
import { terminalAdmissionState } from "./team-task-admission-state.js";

type Input = Parameters<typeof terminalAdmissionState>[0];
const waiting: Input = { completed: false, route: { role: "assignee", messageId: "direction" }, actor: { id: "worker", state: "completed" }, executionState: "active", messageState: "pending" };

describe("terminal admission classification", () => {
  const cases: { name: string; patch: Partial<Input>; expected: ReturnType<typeof terminalAdmissionState> }[] = [
    { name: "waits for an undelivered direction even after worker completion", patch: {}, expected: null },
    { name: "accepts a delivered direction", patch: { messageState: "delivered" }, expected: "completed" },
    { name: "accepts completion without a direction", patch: { route: { role: "assignee", messageId: null } }, expected: "completed" },
    { name: "keeps accepted completion ahead of a later stop", patch: { messageState: "delivered", executionState: "stopped" }, expected: "completed" },
    { name: "keeps a durable completion ahead of cancellation", patch: { completed: true, messageState: "cancelled", actor: { id: "worker", state: "cancelled" } }, expected: "completed" },
    { name: "stops an undelivered direction with its execution", patch: { executionState: "stopped" }, expected: "stopped" },
    { name: "stops cancelled direction independently of actor completion", patch: { messageState: "cancelled" }, expected: "stopped" },
    { name: "requires an explicit completion for the lead", patch: { actor: { id: "lead", state: "completed" }, messageState: "delivered" }, expected: null },
  ];
  it.each(cases)("$name", ({ patch, expected }) => {
    expect(terminalAdmissionState({ ...waiting, ...patch })).toBe(expected);
  });
});

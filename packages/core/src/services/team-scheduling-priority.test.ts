import { describe, expect, it } from "vitest";
import { schedulingPriority } from "./team-scheduling-priority.js";

describe("team scheduling priority", () => {
  const ambient = { requestId: "request", since: 1, dueAt: 2, throughSeq: 1 };
  it("takes user-addressed lead work before its ambient read", () => {
    expect(schedulingPriority({ actor: { id: "lead", ambient }, pending: [{ senderId: "user" }], actors: [] })).toBe(-1);
    expect(schedulingPriority({ actor: { id: "lead", ambient }, pending: [], actors: [] })).toBe(3);
  });
  it("gives subtree owners precedence over leaves but treats participant children as peers", () => {
    const input = { actor: { id: "manager" }, pending: [{ senderId: "lead" }] };
    expect(schedulingPriority({ ...input, actors: [{ parentId: "manager" }] })).toBe(1);
    expect(schedulingPriority({ ...input, actors: [{ parentId: "manager", participant: true }] })).toBe(2);
  });
});

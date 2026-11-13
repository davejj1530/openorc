import { describe, expect, it, vi } from "vitest";
import type { ApprovalResolution } from "@openorc/protocol";
import type { FormRun } from "../acp/forms.js";
import { answerCursorQuestion, cursorQuestion, presentCursorPlan } from "./interactions.js";

const question = cursorQuestion.parse({
  toolCallId: "ask-1",
  title: "Pick a target",
  questions: [
    {
      id: "target",
      prompt: "Which target?",
      options: [
        { id: "browser", label: "Web" },
        { id: "phone", label: "Mobile" },
      ],
    },
  ],
});
function run(answer: ApprovalResolution = { decision: "allow", answers: { target: ["Mobile"] } }): FormRun {
  return {
    runId: "run-1",
    agentName: "Cursor",
    planning: true,
    session: () => "session-1",
    pending: new Map(),
    ask: vi.fn(async () => answer),
    emit: vi.fn(),
    planText: async () => null,
    planShown: vi.fn(),
  };
}

describe("Cursor interactions", () => {
  it("maps visible question choices back to Cursor's IDs", async () => {
    const context = run();
    await expect(answerCursorQuestion(question, context)).resolves.toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "target", selectedOptionIds: ["phone"] }] } });
    expect(context.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "user_input",
        input: { questions: [{ id: "target", question: "Which target?", options: [{ label: "Web" }, { label: "Mobile" }], multiSelect: false, allowOther: false }] },
      }),
    );
    expect(context.pending.size).toBe(0);
  });
  it("skips a denied question or an answer that is not one of the offered choices", async () => {
    for (const answer of [{ decision: "deny" }, { decision: "allow", answers: { target: ["Unknown"] } }] satisfies ApprovalResolution[]) {
      await expect(answerCursorQuestion(question, run(answer))).resolves.toEqual({ outcome: { outcome: "skipped" } });
    }
  });
  it("answers cancellation even when the UI has not answered", async () => {
    const context = run();
    context.ask = () => new Promise(() => {});
    const pending = answerCursorQuestion(question, context);
    for (const request of context.pending.values()) request.cancel();
    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(context.pending.size).toBe(0);
  });
  it("shows the entire plan and stops Plan mode before implementation", () => {
    const context = run();
    expect(presentCursorPlan({ toolCallId: "plan-1", plan: "# Plan\n\n1. Add tests." }, context)).toMatchObject({ outcome: { outcome: "rejected" } });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "plan.updated", text: "# Plan\n\n1. Add tests." }));
    expect(context.planShown).toHaveBeenCalledOnce();
  });
  it("rejects malformed extension payloads at the boundary", () => {
    expect(() => cursorQuestion.parse({ questions: [{ prompt: "Missing identifiers" }] })).toThrow();
  });
});

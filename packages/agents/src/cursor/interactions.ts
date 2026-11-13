import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FormRun } from "../acp/forms.js";

export const cursorQuestion = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  questions: z.array(z.object({ id: z.string(), prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), allowMultiple: z.boolean().optional() })),
});
export const cursorPlan = z.object({ toolCallId: z.string(), name: z.string().optional(), plan: z.string() });

type QuestionResponse = { outcome: { outcome: "answered"; answers: { questionId: string; selectedOptionIds: string[] }[] } | { outcome: "skipped" | "cancelled" } };

/** Cursor uses option IDs on the wire; OpenOrc's question cards return their visible labels. */
export function answerCursorQuestion(params: z.infer<typeof cursorQuestion>, run: FormRun): Promise<QuestionResponse> {
  const owner = run.session();
  if (!owner) return Promise.resolve({ outcome: { outcome: "cancelled" } });
  const approvalId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const respond = (response: QuestionResponse) => {
      if (settled) return;
      settled = true;
      run.pending.delete(approvalId);
      resolve(response);
    };
    run.pending.set(approvalId, { sessionId: owner, cancel: () => respond({ outcome: { outcome: "cancelled" } }) });
    void run
      .ask({
        runId: run.runId,
        approvalId,
        kind: "user_input",
        toolName: "question",
        onceOnly: true,
        detail: params.title ?? params.questions.map((question) => question.prompt).join(" / "),
        input: {
          questions: params.questions.map((question) => ({
            id: question.id,
            question: question.prompt,
            options: question.options.map((option) => ({ label: option.label })),
            multiSelect: question.allowMultiple ?? false,
            allowOther: false,
          })),
        },
      })
      .then(
        (answer) => {
          if (settled) return;
          const decision = typeof answer === "string" ? answer : answer.decision;
          const answers = typeof answer === "string" ? undefined : answer.answers;
          const selected = params.questions.map((question) => ({
            questionId: question.id,
            selectedOptionIds: question.options.filter((option) => answers?.[question.id]?.includes(option.label)).map((option) => option.id),
          }));
          const valid = params.questions.every((question, index) => selected[index]!.selectedOptionIds.length > 0 && (question.allowMultiple || selected[index]!.selectedOptionIds.length === 1));
          respond(decision === "deny" || !valid ? { outcome: { outcome: "skipped" } } : { outcome: { outcome: "answered", answers: selected } });
          run.emit({ type: "approval.resolved", runId: run.runId, ts: Date.now(), approvalId, decision, ...(answers ? { answers } : {}) });
        },
        () => respond({ outcome: { outcome: "cancelled" } }),
      );
  });
}

/** A plan stays a proposal until the person chooses to implement it in OpenOrc. */
export function presentCursorPlan(params: z.infer<typeof cursorPlan>, run: FormRun) {
  if (params.plan.trim()) run.emit({ type: "plan.updated", runId: run.runId, ts: Date.now(), documentId: params.toolCallId, text: params.plan });
  if (run.planning) {
    run.planShown();
    return { outcome: { outcome: "rejected", reason: "The plan is shown in OpenOrc. Wait for the user to choose Implement." } };
  }
  return { outcome: { outcome: "accepted" } };
}

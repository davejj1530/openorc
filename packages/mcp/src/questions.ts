import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const question = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .refine((id) => !(id in Object.prototype), "Reserved question id"),
    question: text,
    header: z.string().max(100).optional(),
    options: z
      .array(z.object({ label: text.refine((label) => label !== "__other", "Reserved option label"), description: z.string().max(4000).optional() }))
      .min(1)
      .max(30)
      .optional(),
    multiSelect: z.boolean().optional(),
    allowOther: z.boolean().optional().describe("Allow a custom answer alongside the choices; defaults to true."),
  })
  .refine((q) => !q.options || new Set(q.options.map((o) => o.label)).size === q.options.length, "Option labels must be unique");

export const UserInput = z.object({
  questions: z
    .array(question)
    .min(1)
    .max(10)
    .refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length, "Question ids must be unique"),
});
export type UserInput = z.infer<typeof UserInput>;
export type UserInputResult = { requestId: string; status: "answered"; answers: Record<string, string[]> } | { requestId: string; status: "cancelled" };

/** Validate the reply against the exact waiting call, before consuming it. */
export function validateUserAnswers(input: UserInput, answers: Record<string, string[]> | undefined): void {
  if (!answers || Object.keys(answers).length !== input.questions.length) throw new Error("Answer every question in this request.");
  for (const q of input.questions) {
    const values = answers[q.id];
    if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string" || !v.trim() || v.length > 4000)) throw new Error(`Missing or invalid answer for ${q.id}.`);
    if ((!q.multiSelect && values.length !== 1) || new Set(values).size !== values.length) throw new Error(`Invalid selection for ${q.id}.`);
    if (q.options && q.allowOther === false && values.some((v) => !q.options!.some((o) => o.label === v))) throw new Error(`Unknown choice for ${q.id}.`);
  }
}

import type { Question } from "./approval-request.js";

/**
 * A question ask's answers as the person builds them, one question at a time: what is picked of each, what is written
 * in each one's own line, which question shows, and whether every answer is in view for the one Answer that sends them.
 * A pick of the ask's own line is kept as `LINE` among the picks, so its words count only once chosen.
 */
export interface AnswerDraft {
  step: number;
  review: boolean;
  picked: Readonly<Record<string, readonly string[]>>;
  lines: Readonly<Record<string, string>>;
}

export const LINE = "\u0000line";

export const emptyDraft: AnswerDraft = { step: 0, review: false, picked: {}, lines: {} };

export type AnswerAction =
  /** A press on a choice of the question that shows. */
  | { kind: "choose"; label: string }
  /** Words written in the question's own line. */
  | { kind: "write"; text: string }
  /** The line's words taken, by Enter in it or its pill. */
  | { kind: "keep" }
  /** Answer, or Next while questions remain. */
  | { kind: "answer" }
  /** A kept answer's line pressed: that question shows again. */
  | { kind: "reopen"; step: number };

/** What a draft turns into: the next draft, and the answers to send when the step sent them. */
export interface AnswerStep {
  draft: AnswerDraft;
  send: Record<string, string[]> | null;
}

/** A question's answer as it stands: its picks, with the line's words where the line is picked or is all it has. */
export function answerFor(q: Question, draft: AnswerDraft): string[] {
  const typed = (draft.lines[q.key] ?? "").trim();
  if (!q.options) return typed ? [typed] : [];
  const picked = draft.picked[q.key] ?? [];
  return [...picked.filter((value) => value !== LINE), ...(picked.includes(LINE) && typed ? [typed] : [])];
}

/** Whether the question's own line holds words not yet taken: its pill shows, and is the ask's ink. */
export function lineWaiting(q: Question | undefined, draft: AnswerDraft): boolean {
  return Boolean(q && (draft.lines[q.key] ?? "").trim() && !(draft.picked[q.key] ?? []).includes(LINE));
}

/** Every question's answer, keyed as the agent asked them. */
export function answersOf(questions: readonly Question[], draft: AnswerDraft): Record<string, string[]> {
  return Object.fromEntries(questions.map((q) => [q.key, answerFor(q, draft)]));
}

/** The answers already given above the question that shows: each can be reopened. */
export function keptAnswers(questions: readonly Question[], draft: AnswerDraft): { step: number; question: Question; answer: string[] }[] {
  if (questions.length < 2) return [];
  return questions.flatMap((question, step) => {
    const answer = answerFor(question, draft);
    return answer.length && (draft.review || step !== draft.step) ? [{ step, question, answer }] : [];
  });
}

/** On to the first question after this one still unanswered, or, with none left, every answer in view. */
function onward(questions: readonly Question[], draft: AnswerDraft): AnswerDraft {
  const undone = questions.findIndex((q, i) => i > draft.step && !answerFor(q, draft).length);
  return undone >= 0 ? { ...draft, step: undone } : { ...draft, review: true };
}

/** One ask with one question takes its answer at once; several are each kept and the last Answer sends them all. */
function settle(questions: readonly Question[], draft: AnswerDraft): AnswerStep {
  if (questions.length === 1) return { draft, send: answersOf(questions, draft) };
  return { draft: onward(questions, draft), send: null };
}

type Step<K extends AnswerAction["kind"]> = (questions: readonly Question[], draft: AnswerDraft, q: Question, action: Extract<AnswerAction, { kind: K }>) => AnswerStep;

const unchanged = (draft: AnswerDraft): AnswerStep => ({ draft, send: null });

/** What each action does to the question that shows. */
const STEPS: { [K in Exclude<AnswerAction["kind"], "reopen" | "answer">]: Step<K> } = {
  write: (_questions, draft, q, action) => unchanged({ ...draft, lines: { ...draft.lines, [q.key]: action.text } }),
  choose: (questions, draft, q, action) => {
    const had = draft.picked[q.key] ?? [];
    if (!q.multi) return settle(questions, { ...draft, picked: { ...draft.picked, [q.key]: [action.label] } });
    return unchanged({ ...draft, picked: { ...draft.picked, [q.key]: had.includes(action.label) ? had.filter((v) => v !== action.label) : [...had, action.label] } });
  },
  keep: (questions, draft, q) => {
    if (!(draft.lines[q.key] ?? "").trim()) return unchanged(draft);
    if (!q.options) return settle(questions, draft);
    const had = draft.picked[q.key] ?? [];
    const picked = { ...draft.picked, [q.key]: q.multi ? [...had.filter((v) => v !== LINE), LINE] : [LINE] };
    return q.multi ? unchanged({ ...draft, picked }) : settle(questions, { ...draft, picked });
  },
};

/** Answer, or Next: sends every answer once all are in view, or the one question's; otherwise moves on once answered. */
function answer(questions: readonly Question[], draft: AnswerDraft): AnswerStep {
  const q = questions[draft.step];
  const answered = Boolean(q && answerFor(q, draft).length);
  if (draft.review || (questions.length === 1 && answered)) return { draft, send: answersOf(questions, draft) };
  return unchanged(answered ? onward(questions, draft) : draft);
}

export function stepAnswers(questions: readonly Question[], draft: AnswerDraft, action: AnswerAction): AnswerStep {
  if (action.kind === "reopen") return unchanged({ ...draft, step: action.step, review: false });
  if (action.kind === "answer") return answer(questions, draft);
  const q = questions[draft.step];
  if (!q || draft.review) return unchanged(draft);
  return (STEPS[action.kind] as Step<typeof action.kind>)(questions, draft, q, action as never);
}

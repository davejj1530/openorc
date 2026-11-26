import { describe, expect, it } from "vitest";
import { answerFor, emptyDraft, stepAnswers, type AnswerAction, type AnswerDraft } from "./ask-answers.js";
import { readQuestions } from "./approval-request.js";

const land = { id: "land", question: "Where should the export land?", options: [{ label: "Downloads folder" }, { label: "Ask each time" }], isOther: true };
const format = { id: "format", question: "Which format comes first?", options: [{ label: "CSV" }, { label: "JSON" }] };
const checks = {
  id: "checks",
  question: "Which checks should run before a merge?",
  options: [{ label: "Type check" }, { label: "Unit tests" }, { label: "The packaged smoke test" }],
  multiSelect: true,
};

/** Plays presses on an ask, returning the draft it ends on and every send it made. `confirm`: every answer waits for Answer. */
function play(questions: unknown[], ...actions: AnswerAction[]): { draft: AnswerDraft; sent: Record<string, string[]>[] } {
  return playing(false, questions, ...actions);
}

function playing(confirm: boolean, questions: unknown[], ...actions: AnswerAction[]): { draft: AnswerDraft; sent: Record<string, string[]>[] } {
  const qs = readQuestions({ questions });
  let draft = emptyDraft;
  const sent: Record<string, string[]>[] = [];
  for (const action of actions) {
    const step = stepAnswers(qs, draft, action, confirm);
    draft = step.draft;
    if (step.send) sent.push(step.send);
  }
  return { draft, sent };
}

describe("answering a question ask", () => {
  it("answers a single choice at its press", () => {
    expect(play([land], { kind: "choose", label: "Ask each time" }).sent).toEqual([{ land: ["Ask each time"] }]);
  });

  it("picks a single choice without sending when its answer is confirmed, then sends it at Answer", () => {
    const picked = playing(true, [land], { kind: "choose", label: "Ask each time" });
    expect(picked.sent).toEqual([]);
    expect(picked.draft.picked).toEqual({ land: ["Ask each time"] });
    expect(playing(true, [land], { kind: "choose", label: "Ask each time" }, { kind: "choose", label: "Downloads folder" }, { kind: "answer" }).sent).toEqual([{ land: ["Downloads folder"] }]);
    expect(playing(true, [land], { kind: "write", text: "Beside the filter" }, { kind: "keep" }).sent).toEqual([]);
  });

  it("toggles several choices and sends them only at Answer", () => {
    const { sent } = play([checks], { kind: "choose", label: "Type check" }, { kind: "choose", label: "Unit tests" }, { kind: "choose", label: "Type check" });
    expect(sent).toEqual([]);
    expect(play([checks], { kind: "choose", label: "Type check" }, { kind: "choose", label: "Unit tests" }, { kind: "answer" }).sent).toEqual([{ checks: ["Type check", "Unit tests"] }]);
  });

  it("does nothing at Answer before anything is picked", () => {
    expect(play([checks], { kind: "answer" }).sent).toEqual([]);
  });

  it("answers in the person's own words only once the line is kept, and not with an empty line", () => {
    expect(play([land], { kind: "write", text: "  " }, { kind: "keep" }).sent).toEqual([]);
    expect(play([land], { kind: "write", text: "Downloads, renamed" }).sent).toEqual([]);
    expect(play([land], { kind: "write", text: "Downloads, renamed" }, { kind: "keep" }).sent).toEqual([{ land: ["Downloads, renamed"] }]);
  });

  it("adds the line's words to several choices without sending", () => {
    const { draft, sent } = play([{ ...checks, isOther: true }], { kind: "choose", label: "Type check" }, { kind: "write", text: "Lint" }, { kind: "keep" });
    expect(sent).toEqual([]);
    expect(play([{ ...checks, isOther: true }], { kind: "choose", label: "Type check" }, { kind: "write", text: "Lint" }, { kind: "keep" }, { kind: "answer" }).sent).toEqual([
      { checks: ["Type check", "Lint"] },
    ]);
    expect(draft.step).toBe(0);
  });

  it("takes three questions one at a time, keeps each answer, and sends nothing until the last Answer", () => {
    const partway = play([land, format, checks], { kind: "choose", label: "Downloads folder" });
    expect([partway.draft.step, partway.sent]).toEqual([1, []]);
    expect(readQuestions({ questions: [land, format, checks] }).map((q) => answerFor(q, partway.draft))).toEqual([["Downloads folder"], [], []]);
    const all = play(
      [land, format, checks],
      { kind: "choose", label: "Downloads folder" },
      { kind: "choose", label: "JSON" },
      { kind: "choose", label: "Type check" },
      { kind: "choose", label: "The packaged smoke test" },
      { kind: "answer" },
    );
    expect([all.draft.review, all.sent]).toEqual([true, []]);
    expect(
      play([land, format, checks], { kind: "choose", label: "Downloads folder" }, { kind: "choose", label: "JSON" }, { kind: "choose", label: "Unit tests" }, { kind: "answer" }, { kind: "answer" })
        .sent,
    ).toEqual([{ land: ["Downloads folder"], format: ["JSON"], checks: ["Unit tests"] }]);
  });

  it("reopens a kept answer, and moves past questions already answered", () => {
    const { draft } = play(
      [land, format, checks],
      { kind: "choose", label: "Downloads folder" },
      { kind: "choose", label: "CSV" },
      { kind: "reopen", step: 0 },
      { kind: "choose", label: "Ask each time" },
    );
    expect([draft.step, draft.picked]).toEqual([2, { land: ["Ask each time"], format: ["CSV"] }]);
  });
});

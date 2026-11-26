import { useContext, useState, type CSSProperties, type ReactNode } from "react";
import { answerFor, emptyDraft, LINE, lineWaiting, readQuestions, stepAnswers, type AnswerAction, type AnswerDraft, type Question, type WaitingAsk } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { answeredInThisWindow, AskContinues, useAskAnswer } from "./ask-answer";
import { useRunVoice } from "../lib/turn-authors";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { Check } from "./icons";
import { HarnessLogo } from "./HarnessLogo";
import { askKeyDown, AskBack, AskError, AskFoot, AskLine, AskRing, AskTop, AskWay } from "./AskParts";

/** What was answered outside the options: a custom answer, or a question that had none. Secret answers stay hidden. */
function answeredText(q: Question, answer: string[]): ReactNode {
  const extra = q.options ? answer.filter((value) => !q.options!.some((o) => o.label === value)) : answer;
  if (!extra.length) return null;
  return (
    <div className="question-answer" aria-label="Your answer">
      {q.secret ? (
        <p>Answer hidden</p>
      ) : (
        extra.map((value, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">
            {value}
          </p>
        ))
      )}
    </div>
  );
}

/**
 * One option as the answer left it: the chosen ones take the ink pill and the rest step back, one after another, as
 * the answer lands. A conversation loaded already answered shows that at once.
 */
function OptionRow({ option, index, chosen }: { option: { label: string; description: string }; index: number; chosen: boolean }) {
  return (
    <div className="question-option" data-state={chosen ? "chosen" : "dropped"} style={{ "--option-index": index } as CSSProperties}>
      <span className="question-option-label">
        {option.label}
        {option.description ? <span className="question-option-description">{option.description}</span> : null}
      </span>
      <Check size={16} className="question-option-check" />
    </div>
  );
}

/**
 * An agent's question where it was asked. Answered or declined, it is the record of what was asked and answered;
 * while it waits where no composer takes it (a task's comment, a task's activity), it is the ask itself, as the
 * composer docks it.
 */
export function QuestionCard({
  runId,
  approvalId,
  input,
  decided,
  answers,
}: {
  runId: string;
  approvalId: string;
  input: unknown;
  decided: string | undefined;
  answers?: Record<string, string[]> | undefined;
}) {
  const voice = useRunVoice(runId);
  // A record lands when it was asked on this screen, or answered from this window's composer; history shows still.
  const [asked] = useState(() => !decided || answeredInThisWindow(approvalId));
  if (!decided)
    return (
      <div data-blocking="true" data-plane className="question-card" onKeyDown={askKeyDown(() => {})}>
        <QuestionAsk ask={{ runId, block: { id: approvalId, kind: "approval", approvalId, approvalKind: "user_input", input } }} more={0} fieldHasWords={false} />
      </div>
    );
  const questions = readQuestions(input);
  const chosen = (q: Question): string[] => (decided === "deny" ? [] : (answers?.[q.key] ?? []));
  return (
    <div data-plane className={cn("question-card", asked && "motion-arrive")}>
      {questions.map((q, i) => (
        <fieldset key={q.key} className="question-set">
          <legend className="question-ask">
            {i === 0 && voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} /> : null}
            <span>{q.question || q.header}</span>
          </legend>
          <div className="question-options">
            {q.options?.map((o, index) => (
              <OptionRow key={o.label} option={o} index={index} chosen={chosen(q).includes(o.label)} />
            ))}
            {decided !== "deny" ? answeredText(q, answers?.[q.key] ?? []) : null}
          </div>
        </fieldset>
      ))}
      <p className="question-foot" role="status">
        {decided === "deny" ? "Declined" : `Sent to ${voice ? harnessShortName(voice.agent) : "the agent"}`}
      </p>
    </div>
  );
}

/** What a control of the ask needs while it waits: whether it takes a press, and why not, on demand. */
type Hold = { off: boolean; tip: string | undefined };

/**
 * A question docked onto the composer while it waits: the question alone across the top, its choices as rows, its own
 * line for words when its agent takes them, and one row under them for its way out and, once the answer is more than
 * one press, Answer. Several questions in one ask come one at a time: the row counts them and steps back to the one
 * before, and with the last answered every answer shows, each a row that reopens its question, before Answer sends
 * them all.
 */
export function QuestionAsk({ ask, more, fieldHasWords, onStep }: { ask: WaitingAsk; more: number; fieldHasWords: boolean; onStep?: () => void }) {
  const questions = readQuestions(ask.block.input);
  const voice = useRunVoice(ask.runId);
  const reply = useAskAnswer(ask.runId, ask.block.approvalId);
  // A parked ask of someone else's turn starts the reader's own paid turn: its answer waits for Answer and continue.
  const continues = useContext(AskContinues)(ask.block.approvalId);
  const [draft, setDraft] = useState<AnswerDraft>(emptyDraft);
  const hold: Hold = { off: reply.pending || Boolean(reply.blocked), tip: reply.blocked ?? undefined };
  const act = (action: AnswerAction) => {
    const next = stepAnswers(questions, draft, action, Boolean(continues));
    if (next.send) return reply.answer("allow", next.send);
    if (next.draft.step !== draft.step || next.draft.review !== draft.review) onStep?.();
    setDraft(next.draft);
  };
  const q = draft.review ? undefined : questions[draft.step];
  const many = questions.length > 1;
  return (
    <>
      <AskTop mark={<AgentMark voice={voice} />}>{q ? q.question || q.header : "Your answers"}</AskTop>
      <div className="composer-ask-body">
        {q ? (
          <QuestionStep q={q} draft={draft} keepWords={many || q.multi || continues ? "Keep" : "Answer"} ink={!fieldHasWords} hold={hold} act={act} />
        ) : (
          <Answers questions={questions} draft={draft} hold={hold} act={act} />
        )}
      </div>
      <AskError error={reply.error} />
      <AskFoot
        {...standing(questions, draft, hold, act)}
        more={more}
        ways={
          <AskWay disabled={hold.off} tip={hold.tip} onClick={() => reply.answer("deny")}>
            Decline
          </AskWay>
        }
      >
        <Onward q={q} many={many} continues={continues} draft={draft} ink={!fieldHasWords && !lineWaiting(q, draft)} hold={hold} act={act} />
      </AskFoot>
    </>
  );
}

/** The asking agent's mark, when its run says who it is. */
function AgentMark({ voice }: { voice: ReturnType<typeof useRunVoice> }) {
  return voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} /> : null;
}

/**
 * Where an ask of several questions stands, for its row: its count, behind a step back from the second question on.
 * One question has nothing to count, and nor does the view of every answer.
 */
function standing(questions: readonly Question[], draft: AnswerDraft, hold: Hold, act: (action: AnswerAction) => void): { back?: ReactNode; count?: string } {
  if (questions.length < 2 || draft.review) return {};
  const count = `${draft.step + 1} of ${questions.length}`;
  if (draft.step === 0) return { count };
  return { count, back: <AskBack disabled={hold.off} tip={hold.tip} onClick={() => act({ kind: "reopen", step: draft.step - 1 })} /> };
}

/** Every answer before it is sent: each question by its short name, or its own words when it has none, each a row that reopens it. */
function Answers({ questions, draft, hold, act }: { questions: readonly Question[]; draft: AnswerDraft; hold: Hold; act: (action: AnswerAction) => void }) {
  return (
    <div className="composer-ask-answers">
      {questions.map((q, step) => (
        <button key={q.key} type="button" tabIndex={-1} className="composer-ask-answer focus-ring" data-ask-control="action" disabled={hold.off} onClick={() => act({ kind: "reopen", step })}>
          <span className="composer-ask-answer-name">{q.header || q.question}</span>
          <span className="composer-ask-answer-words">{q.secret ? "Answer hidden" : answerFor(q, draft).map((words) => <span key={words}>{words}</span>)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The ask's way on, once its answer is more than one press: Next while questions remain, Answer for the last, the ask's
 * one ink unless words wait elsewhere. With every answer in view it always shows. An answer that continues on the
 * reader's own hours is always confirmed here, and says so on demand.
 */
function Onward({
  q,
  many,
  continues,
  draft,
  ink,
  hold,
  act,
}: {
  q: Question | undefined;
  many: boolean;
  continues: string | null;
  draft: AnswerDraft;
  ink: boolean;
  hold: Hold;
  act: (action: AnswerAction) => void;
}) {
  if (q && !((q.multi || many || continues) && answerFor(q, draft).length > 0)) return null;
  return (
    <Button
      size="md"
      variant={ink ? "primary" : "secondary"}
      className="focus-ring"
      tabIndex={-1}
      data-ask-control="action"
      disabled={hold.off}
      data-tip={hold.tip ?? continues ?? undefined}
      onClick={() => act({ kind: "answer" })}
    >
      {onwardWords(many && Boolean(q), continues)}
    </Button>
  );
}

/** Next while questions remain, else Answer, and Answer and continue where the answer starts the reader's own turn. */
function onwardWords(next: boolean, continues: string | null): string {
  if (next) return "Next";
  return continues ? "Answer and continue" : "Answer";
}

/**
 * The question that shows: its choices as rows, each behind a ring that turns to an ink check once picked, then its
 * own line for words when its agent takes them, as one more row.
 */
function QuestionStep({ q, draft, keepWords, ink, hold, act }: { q: Question; draft: AnswerDraft; keepWords: string; ink: boolean; hold: Hold; act: (action: AnswerAction) => void }) {
  const picked = draft.picked[q.key] ?? [];
  return (
    <>
      {q.options?.map((option) => (
        <button
          key={option.label}
          type="button"
          tabIndex={-1}
          className="composer-ask-choice focus-ring"
          aria-pressed={picked.includes(option.label)}
          data-picked={picked.includes(option.label) || undefined}
          data-ask-control="choice"
          disabled={hold.off}
          data-tip={hold.tip}
          onClick={() => act({ kind: "choose", label: option.label })}
        >
          <span className="composer-ask-mark">
            <AskRing />
          </span>
          <span>{option.label}</span>
          {option.description ? <span className="composer-ask-choice-description">{option.description}</span> : null}
        </button>
      ))}
      {q.allowOther ? (
        <AskLine
          key={q.key}
          label={q.options ? `Something else: ${q.question}` : q.question}
          placeholder={q.options ? "Something else" : "Your answer"}
          secret={q.secret}
          mark={q.options ? <AskRing /> : null}
          picked={picked.includes(LINE)}
          value={draft.lines[q.key] ?? ""}
          onChange={(text) => act({ kind: "write", text })}
          send={lineWaiting(q, draft) ? { words: keepWords, ink, onSend: () => act({ kind: "keep" }) } : null}
          disabled={hold.off}
          tip={hold.tip}
        />
      ) : null}
    </>
  );
}

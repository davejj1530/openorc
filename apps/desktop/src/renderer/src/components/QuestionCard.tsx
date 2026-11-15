import { useContext, useState, type CSSProperties, type ReactNode } from "react";
import { answerFor, emptyDraft, keptAnswers, LINE, lineWaiting, readQuestions, stepAnswers, type AnswerAction, type AnswerDraft, type Question, type WaitingAsk } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { answeredInThisWindow, AskContinues, useAskAnswer } from "./ask-answer";
import { useRunVoice } from "../lib/turn-authors";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { Check } from "./icons";
import { HarnessLogo } from "./HarnessLogo";
import { askKeyDown, AskError, AskLine, AskTop, AskWay } from "./AskParts";

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
 * A question docked onto the composer while it waits: its top line, its choices as keys, its own line for words when
 * its agent takes them, and a row for Answer when the answer is more than one press. Several questions in one ask come
 * one at a time under one count, each answer kept above as a line that reopens it; the last Answer sends them all.
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
      <AskTop
        mark={<AgentMark voice={voice} />}
        more={more}
        count={many && q ? `${draft.step + 1} of ${questions.length}` : undefined}
        way={
          <AskWay disabled={hold.off} tip={hold.tip} onClick={() => reply.answer("deny")}>
            Decline
          </AskWay>
        }
      >
        {q ? q.question || q.header : "Your answers"}
      </AskTop>
      <div className="composer-ask-body">
        <KeptAnswers questions={questions} draft={draft} hold={hold} act={act} />
        {q ? <QuestionStep q={q} draft={draft} confirm={Boolean(continues)} keepWords={many || q.multi || continues ? "Keep" : "Answer"} ink={!fieldHasWords} hold={hold} act={act} /> : null}
      </div>
      <AskError error={reply.error} />
      <QuestionRow q={q} many={many} continues={continues} draft={draft} ink={!fieldHasWords && !lineWaiting(q, draft)} hold={hold} act={act} />
    </>
  );
}

/** The asking agent's mark, when its run says who it is. */
function AgentMark({ voice }: { voice: ReturnType<typeof useRunVoice> }) {
  return voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} /> : null;
}

/** The answers already given above the question that shows, each a line that reopens it. */
function KeptAnswers({ questions, draft, hold, act }: { questions: readonly Question[]; draft: AnswerDraft; hold: Hold; act: (action: AnswerAction) => void }) {
  return keptAnswers(questions, draft).map((kept) => (
    <button
      key={kept.question.key}
      type="button"
      tabIndex={-1}
      className="composer-ask-kept focus-ring"
      data-ask-control="action"
      disabled={hold.off}
      onClick={() => act({ kind: "reopen", step: kept.step })}
    >
      <span className="composer-ask-kept-question">{kept.question.question || kept.question.header}</span>
      <span className="composer-ask-kept-answer">{kept.question.secret ? "Answer hidden" : kept.answer.join(", ")}</span>
    </button>
  ));
}

/**
 * The ask's row, once its answer is more than one press: Next while questions remain, Answer for the last, the ask's
 * one ink unless words wait elsewhere. With every answer in view it always shows. An answer that continues on the
 * reader's own hours is always confirmed here, and says so on demand.
 */
function QuestionRow({
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
    <div className="composer-ask-row">
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
        {rowWords(many && Boolean(q), continues)}
      </Button>
    </div>
  );
}

/** Next while questions remain, else Answer, and Answer and continue where the answer starts the reader's own turn. */
function rowWords(next: boolean, continues: string | null): string {
  if (next) return "Next";
  return continues ? "Answer and continue" : "Answer";
}

/**
 * The question that shows: its choices, then its own line for words when its agent takes them. A choice that is only
 * picked, as several choices are or one whose answer is confirmed, says so and wears its check.
 */
function QuestionStep({
  q,
  draft,
  confirm,
  keepWords,
  ink,
  hold,
  act,
}: {
  q: Question;
  draft: AnswerDraft;
  confirm: boolean;
  keepWords: string;
  ink: boolean;
  hold: Hold;
  act: (action: AnswerAction) => void;
}) {
  const picked = draft.picked[q.key] ?? [];
  const picks = q.multi || confirm;
  const words = draft.lines[q.key] ?? "";
  return (
    <>
      {q.options?.map((option) => (
        <button
          key={option.label}
          type="button"
          tabIndex={-1}
          className="composer-ask-choice focus-ring"
          aria-pressed={picks ? picked.includes(option.label) : undefined}
          data-picked={picked.includes(option.label) || undefined}
          data-ask-control="choice"
          disabled={hold.off}
          data-tip={hold.tip}
          onClick={() => act({ kind: "choose", label: option.label })}
        >
          <span>{option.label}</span>
          {option.description ? <span className="composer-ask-choice-description">{option.description}</span> : null}
          {picks ? <Check size={16} className="composer-ask-check" /> : null}
        </button>
      ))}
      {q.allowOther ? (
        <AskLine
          key={q.key}
          label={q.options ? `Something else: ${q.question}` : q.question}
          placeholder={q.options ? "Something else" : "Your answer"}
          secret={q.secret}
          picked={picked.includes(LINE)}
          value={words}
          onChange={(text) => act({ kind: "write", text })}
          send={lineWaiting(q, draft) ? { words: keepWords, ink, onSend: () => act({ kind: "keep" }) } : null}
          disabled={hold.off}
          tip={hold.tip}
        />
      ) : null}
    </>
  );
}

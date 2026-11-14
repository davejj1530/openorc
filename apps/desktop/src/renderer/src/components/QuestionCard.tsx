import { useState, type CSSProperties, type ReactNode } from "react";
import { type Question, type WaitingAsk, readQuestions } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { useAskAnswer } from "./ask-answer";
import { useRunVoice } from "../lib/turn-authors";
import { Button, Input } from "./ui";
import { cn } from "../lib/cn";
import { Check } from "./icons";
import { HarnessLogo } from "./HarnessLogo";
import { AskError, AskLine, AskTop, AskWay } from "./AskParts";

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
 * One option as a 44px fill row. Picking it marks it with a check; once the answer is sent the chosen rows take the
 * ink pill and the rest step back, one after another. A conversation loaded already answered shows that at once.
 */
function OptionRow({ q, option, index, name, picked, decided, onToggle }: OptionProps) {
  let state: string | undefined;
  if (decided) state = picked ? "chosen" : "dropped";
  return (
    <label className="question-option" data-picked={picked || undefined} data-state={state} style={{ "--option-index": index } as CSSProperties}>
      <input type={q.multi ? "checkbox" : "radio"} name={name} className="sr-only" checked={picked} disabled={Boolean(decided)} onChange={onToggle} />
      <span className="question-option-label">
        {option.label}
        {option.description ? <span className="question-option-description">{option.description}</span> : null}
      </span>
      <Check size={16} className="question-option-check" />
    </label>
  );
}

type OptionProps = { q: Question; option: { label: string; description: string }; index: number; name: string; picked: boolean; decided: string | undefined; onToggle: () => void };

/** A free answer in the card: beside the options as "something else", or the whole answer when there are none. */
function OtherAnswer({
  q,
  name,
  picked,
  value,
  onPick,
  onChange,
  onSubmit,
}: {
  q: Question;
  name: string;
  picked: boolean;
  value: string;
  onPick: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <label className="question-other">
      {q.options ? <input type={q.multi ? "checkbox" : "radio"} name={name} className="sr-only" checked={picked} onChange={onPick} /> : null}
      <Input
        variant="sheet"
        type={q.secret ? "password" : "text"}
        aria-label={q.options ? `Custom answer: ${q.question}` : q.question}
        placeholder={q.options ? "Something else" : "Your answer"}
        value={value}
        onFocus={() => q.options && !picked && onPick()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
      />
    </label>
  );
}

/** An agent asked something. Each question gets its options or a text field; one submit answers them all. */
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
  const questions = readQuestions(input);
  const voice = useRunVoice(runId);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const reply = useAskAnswer(runId, approvalId);

  const answerFor = (q: Question): string[] => {
    const chosen = (picked[q.key] ?? []).filter((v) => v !== "__other");
    const free = (other[q.key] ?? "").trim();
    if ((picked[q.key] ?? []).includes("__other") && free) chosen.push(free);
    if (!q.options && free) return [free];
    return chosen;
  };
  const complete = questions.length > 0 && questions.every((q) => answerFor(q).length > 0);

  const toggle = (q: Question, value: string) =>
    setPicked((s) => {
      const current = s[q.key] ?? [];
      if (q.multi) return { ...s, [q.key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] };
      return { ...s, [q.key]: [value] };
    });

  const submit = () => {
    if (!complete || reply.pending || reply.blocked) return;
    const answers: Record<string, string[]> = {};
    for (const q of questions) answers[q.key] = answerFor(q);
    reply.answer("allow", answers);
  };
  const chosen = (q: Question): string[] => {
    if (!decided) return picked[q.key] ?? [];
    return decided === "deny" ? [] : (answers?.[q.key] ?? []);
  };

  return (
    <div data-blocking={decided ? undefined : "true"} data-plane className="question-card">
      {questions.map((q, i) => (
        <fieldset key={q.key} className="question-set">
          <legend className="question-ask">
            {i === 0 && voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} /> : null}
            <span>{q.question || q.header}</span>
          </legend>
          <div className="question-options">
            {q.options?.map((o, index) => (
              <OptionRow key={o.label} q={q} option={o} index={index} name={`${approvalId}-${q.key}`} picked={chosen(q).includes(o.label)} decided={decided} onToggle={() => toggle(q, o.label)} />
            ))}
            {!decided && q.allowOther ? (
              <OtherAnswer
                q={q}
                name={`${approvalId}-${q.key}`}
                picked={(picked[q.key] ?? []).includes("__other")}
                value={other[q.key] ?? ""}
                onPick={() => toggle(q, "__other")}
                onChange={(value) => setOther((s) => ({ ...s, [q.key]: value }))}
                onSubmit={submit}
              />
            ) : null}
            {decided && decided !== "deny" ? answeredText(q, answers?.[q.key] ?? []) : null}
          </div>
        </fieldset>
      ))}
      <QuestionFoot
        decided={decided}
        hint={askHint(questions)}
        agent={voice ? harnessShortName(voice.agent) : null}
        complete={complete}
        reply={reply}
        onSubmit={submit}
        onDecline={() => reply.answer("deny")}
      />
    </div>
  );
}

/** What the card asks of the reader, in a few words. */
function askHint(questions: Question[]): string {
  if (!questions.some((q) => q.options)) return "Type your answer";
  const pick = questions.some((q) => q.multi) ? "Pick any" : "Pick one";
  return questions.some((q) => q.options && q.allowOther) ? `${pick}, or type your own` : pick;
}

/** The foot swaps in place: a hint and the answers' controls while it waits, then where the answer went. */
function QuestionFoot({
  decided,
  hint,
  agent,
  complete,
  reply,
  onSubmit,
  onDecline,
}: {
  decided: string | undefined;
  hint: string;
  agent: string | null;
  complete: boolean;
  reply: Pick<ReturnType<typeof useAskAnswer>, "pending" | "blocked" | "error">;
  onSubmit: () => void;
  onDecline: () => void;
}) {
  const [asked] = useState(!decided);
  if (decided)
    return (
      <p className={cn("question-foot", asked && "motion-arrive")} role="status">
        {decided === "deny" ? "Declined" : `Sent to ${agent ?? "the agent"}`}
      </p>
    );
  return (
    <div className="question-foot">
      {reply.error ? (
        <span role="alert" className="min-w-0 flex-1 text-bad">
          {reply.error}
        </span>
      ) : (
        <span className="min-w-0 flex-1">{hint}</span>
      )}
      <Button size="md" variant="ghost" disabled={reply.pending || Boolean(reply.blocked)} data-tip={reply.blocked ?? undefined} onClick={onDecline}>
        Decline
      </Button>
      <Button size="md" variant="primary" disabled={!complete || reply.pending || Boolean(reply.blocked)} data-tip={reply.blocked ?? undefined} onClick={onSubmit}>
        Answer
      </Button>
    </div>
  );
}

/**
 * A question docked onto the composer while it waits: its top line, its choices as keys, and its own line for words
 * when its agent takes them. A single choice answers when pressed.
 */
export function QuestionAsk({ ask, more, fieldHasWords }: { ask: WaitingAsk; more: number; fieldHasWords: boolean }) {
  const [q] = readQuestions(ask.block.input);
  const voice = useRunVoice(ask.runId);
  const reply = useAskAnswer(ask.runId, ask.block.approvalId);
  const [words, setWords] = useState("");
  if (!q) return null;
  const off = reply.pending || Boolean(reply.blocked);
  const tip = reply.blocked ?? undefined;
  const answer = (value: string) => reply.answer("allow", { [q.key]: [value] });
  return (
    <>
      <AskTop
        mark={voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} /> : null}
        more={more}
        way={
          <AskWay disabled={off} tip={tip} onClick={() => reply.answer("deny")}>
            Decline
          </AskWay>
        }
      >
        {q.question || q.header}
      </AskTop>
      {q.options?.map((option) => (
        <button key={option.label} type="button" tabIndex={-1} className="composer-ask-choice" data-ask-control="choice" disabled={off} data-tip={tip} onClick={() => answer(option.label)}>
          <span>{option.label}</span>
          {option.description ? <span className="composer-ask-choice-description">{option.description}</span> : null}
        </button>
      ))}
      {q.allowOther ? (
        <AskLine
          label={q.options ? `Something else: ${q.question}` : q.question}
          placeholder={q.options ? "Something else" : "Your answer"}
          secret={q.secret}
          value={words}
          onChange={setWords}
          send={{ words: "Answer", ink: !fieldHasWords, onSend: () => words.trim() && answer(words.trim()) }}
          disabled={off}
          tip={tip}
        />
      ) : null}
      <AskError error={reply.error} />
    </>
  );
}

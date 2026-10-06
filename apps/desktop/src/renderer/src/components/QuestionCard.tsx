import { useState, type ReactNode } from "react";
import { core } from "../lib/rpc";
import { Button, Input } from "./ui";
import { cn } from "../lib/cn";

interface Question {
  /** Answer key: Codex uses an id, Claude the question text. */
  key: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
  allowOther: boolean;
  secret: boolean;
  multi: boolean;
}

/** Codex `requestUserInput` and Claude `AskUserQuestion` ask in different shapes; the card is one. */
function readQuestions(input: unknown): Question[] {
  const p = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(p["questions"]) ? (p["questions"] as Record<string, unknown>[]) : [];
  return raw.map((q, i) => {
    const options = Array.isArray(q["options"]) ? (q["options"] as Record<string, unknown>[]).map((o) => ({ label: String(o["label"] ?? ""), description: String(o["description"] ?? "") })) : null;
    const question = String(q["question"] ?? "");
    return {
      key: typeof q["id"] === "string" ? q["id"] : question || String(i),
      header: String(q["header"] ?? ""),
      question,
      options: options && options.length > 0 ? options : null,
      allowOther: typeof q["allowOther"] === "boolean" ? q["allowOther"] || options === null : q["isOther"] === true || options === null || q["multiSelect"] === true,
      secret: q["isSecret"] === true,
      multi: q["multiSelect"] === true,
    };
  });
}

function answeredQuestion(q: Question, answers: Record<string, string[]> | undefined, decided: string): ReactNode {
  if (decided === "deny") return null;
  const answer = answers?.[q.key];
  let content: ReactNode = <p className="text-ink-3">Answer unavailable</p>;
  if (answer?.length) {
    if (q.secret) content = <p>Answer hidden</p>;
    else
      content = answer.map((value, index) => (
        <p key={index} className="whitespace-pre-wrap break-words">
          {value}
        </p>
      ));
  }
  return (
    <div className="space-y-1 text-base text-ink-2" aria-label="Your answer">
      {content}
    </div>
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
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

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
    const answers: Record<string, string[]> = {};
    for (const q of questions) answers[q.key] = answerFor(q);
    void core.call("approvals.resolve", { runId, approvalId, decision: "allow", answers });
  };

  return (
    <div data-blocking={decided ? undefined : "true"} className={cn("question-card my-3 rounded-lg border border-line p-4", decided && "text-ink-2")}>
      {questions.map((q) => (
        <fieldset key={q.key} className="mb-4 min-w-0">
          <legend className="mb-3 text-md font-medium text-ink break-words">{q.question || q.header}</legend>
          {decided ? (
            answeredQuestion(q, answers, decided)
          ) : (
            <div className="grid gap-1.5">
              {q.options?.map((o) => (
                <label
                  key={o.label}
                  className={cn(
                    "flex min-h-10 items-start gap-3 rounded-md px-3 py-2.5 text-base transition-colors hover:bg-surface-2 focus-within:outline focus-within:outline-2 focus-within:outline-accent",
                    (picked[q.key] ?? []).includes(o.label) && "bg-surface-2",
                  )}
                >
                  <input
                    type={q.multi ? "checkbox" : "radio"}
                    name={`${approvalId}-${q.key}`}
                    className="mt-1 shrink-0 accent-current"
                    checked={(picked[q.key] ?? []).includes(o.label)}
                    onChange={() => toggle(q, o.label)}
                  />
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-ink">{o.label}</span>
                    {o.description ? <span className="mt-0.5 block text-ink-2">{o.description}</span> : null}
                  </span>
                </label>
              ))}
              {q.allowOther ? (
                <label className="mt-2 flex items-center gap-3 px-3 text-base">
                  {q.options ? (
                    <input type={q.multi ? "checkbox" : "radio"} name={`${approvalId}-${q.key}`} checked={(picked[q.key] ?? []).includes("__other")} onChange={() => toggle(q, "__other")} />
                  ) : null}
                  <Input
                    type={q.secret ? "password" : "text"}
                    aria-label={q.options ? `Custom answer: ${q.question}` : q.question}
                    placeholder={q.options ? "Write a different answer…" : "Your answer"}
                    value={other[q.key] ?? ""}
                    onFocus={() => q.options && !(picked[q.key] ?? []).includes("__other") && toggle(q, "__other")}
                    onChange={(e) => setOther((s) => ({ ...s, [q.key]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && complete && submit()}
                    className="h-9"
                  />
                </label>
              ) : null}
            </div>
          )}
        </fieldset>
      ))}
      {decided ? (
        <div className="text-sm text-ink-3">{decided === "deny" ? "declined" : "answered"}</div>
      ) : (
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Button size="md" variant="primary" disabled={!complete} onClick={submit}>
            Answer
          </Button>
          <Button size="md" variant="ghost" onClick={() => void core.call("approvals.resolve", { runId, approvalId, decision: "deny" })}>
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

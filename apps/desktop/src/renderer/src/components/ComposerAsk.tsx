import type { WaitingAsk } from "@openorc/client";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnswersBlocked } from "./ask-answer";
import { askKeyDown } from "./AskParts";
import { QuestionAsk } from "./QuestionCard";

/** How long an ask that takes another's place takes to land, in which it takes no press or key. */
const LANDING_MS = 240;

/**
 * The ask an agent waits on, docked at the top of the composer's own piece above a hairline. One shows, and says how
 * many more wait. Its keys follow `askKeyAct`: the keyboard enters at its question only by the person's own key, and
 * Enter acts only on a control the keyboard was put on. Only its question is in the page's tab order and the walk is
 * its own, so no Tab can land on a choice, even one pressed as the ask arrives. Once it is answered the keyboard goes back to the field, so the
 * next key cannot land on the ask that takes its place.
 */
export function ComposerAsk({ asks, blocked, fieldHasWords, focusField }: { asks: WaitingAsk[]; blocked: string | null; fieldHasWords: boolean; focusField: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const ask = asks[0];
  const shown = ask?.block.approvalId;
  const last = useRef(shown);
  const [landing, setLanding] = useState(false);
  useEffect(() => {
    if (last.current === shown) return;
    const swapped = last.current !== undefined && shown !== undefined;
    last.current = shown;
    const focused = document.activeElement;
    if (!focused || focused === document.body || root.current?.contains(focused)) focusField();
    if (!swapped) return;
    // The ask that takes an answered one's place takes no press or key while it lands, so a second Enter or a double
    // press cannot answer what was not read.
    setLanding(true);
    const timer = setTimeout(() => setLanding(false), LANDING_MS);
    return () => clearTimeout(timer);
  }, [shown, focusField]);
  if (!ask) return null;
  const hold = (event: SyntheticEvent) => {
    if (!landing) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <AnswersBlocked.Provider value={blocked}>
      <div
        ref={root}
        role="group"
        aria-label="Waiting on you"
        className="composer-ask"
        data-ask={ask.block.approvalKind === "user_input" ? "question" : "approval"}
        data-landing={landing || undefined}
        onKeyDown={askKeyDown(focusField)}
        onKeyDownCapture={hold}
        onClickCapture={hold}
      >
        <QuestionAsk key={shown} ask={ask} more={asks.length - 1} fieldHasWords={fieldHasWords} onStep={focusField} />
      </div>
    </AnswersBlocked.Provider>
  );
}

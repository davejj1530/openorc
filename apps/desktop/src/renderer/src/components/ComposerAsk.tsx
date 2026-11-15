import type { WaitingAsk } from "@openorc/client";
import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { prefersReducedMotion } from "../lib/motion";
import { AnswersBlocked, AskContinues } from "./ask-answer";
import { askKeyDown } from "./AskParts";
import { ApprovalAsk } from "./ApprovalCard";
import { QuestionAsk } from "./QuestionCard";

const noContinuation = () => null;

/** How long an ask that takes another's place takes to land, in which it takes no press or key. */
const LANDING_MS = 240;

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const PARTS = ".composer-ask-top, .composer-ask-body > *, .composer-ask-error, .composer-ask-row";

/**
 * The dock's motion, as the prototype plays it. It arrives by opening from the height it had to its own while its parts
 * clear a blur and rise one after another; an ask that takes another's place does the same from the height the last
 * one left; it leaves by blurring its parts away, then folding shut. Under reduced motion it is there or gone at once.
 */
function playDock(dock: HTMLElement, from: number, how: "arrive" | "swap" | "leave", done: () => void) {
  if (typeof dock.animate !== "function" || prefersReducedMotion()) return done();
  for (const running of dock.getAnimations({ subtree: true })) running.cancel();
  const parts = [...dock.querySelectorAll<HTMLElement>(PARTS)];
  if (how === "leave") {
    for (const part of parts)
      part.animate(
        [
          { opacity: 1, filter: "blur(0)" },
          { opacity: 0, filter: "blur(3px)" },
        ],
        { duration: 160, easing: EASE, fill: "forwards" },
      );
    const fold = dock.animate([{ height: `${from}px` }, { height: `${from}px`, offset: 0.28 }, { height: "0px" }], { duration: 580, easing: EASE, fill: "forwards" });
    return void fold.finished.then(done, () => {});
  }
  dock.animate([{ height: `${from}px` }, { height: `${dock.getBoundingClientRect().height}px` }], { duration: 420, easing: EASE });
  parts.forEach((part, i) =>
    part.animate(
      [
        { opacity: 0, filter: "blur(4px)", transform: "translateY(4px)" },
        { opacity: 1, filter: "blur(0)", transform: "none" },
      ],
      {
        duration: 220,
        delay: (how === "swap" ? 0 : 90) + i * 40,
        easing: EASE,
        fill: "backwards",
      },
    ),
  );
  done();
}

/**
 * The ask the dock draws: the first waiting, or the one just answered while it leaves. The dock's motion plays as the
 * shown ask changes, from the height the dock had.
 */
function useDockMotion(ask: WaitingAsk | undefined) {
  const dock = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  const [leaving, setLeaving] = useState<WaitingAsk | null>(null);
  const [lastId, setLastId] = useState<string | undefined>(undefined);
  const [lastAsk, setLastAsk] = useState<WaitingAsk | undefined>(undefined);
  const id = ask?.block.approvalId;
  if (id !== lastId) {
    setLeaving(ask ? null : (lastAsk ?? null));
    setLastId(id);
    if (ask) setLastAsk(ask);
  }
  const shown = ask ?? leaving ?? undefined;
  // What the dock shows, as one word: an ask by its id, or that one leaving. Motion plays when this changes.
  const mode = shown ? `${ask ? "ask" : "leave"}:${shown.block.approvalId}` : null;
  const played = useRef<string | null>(null);
  useLayoutEffect(() => {
    const node = dock.current;
    const before = played.current;
    played.current = mode;
    if (node && mode && mode !== before) {
      let how: "arrive" | "swap" | "leave" = before ? "swap" : "arrive";
      if (mode.startsWith("leave")) how = "leave";
      playDock(node, how === "arrive" ? 0 : height.current, how, () => how === "leave" && setLeaving(null));
    }
    height.current = node && ask ? node.getBoundingClientRect().height : 0;
  });
  return { dock, shown, leaving: !ask && Boolean(leaving) };
}

/**
 * The ask an agent waits on, docked at the top of the composer's own piece above a hairline. One shows, and says how
 * many more wait. Its keys follow `askKeyAct`: the keyboard enters at its question only by the person's own key, and
 * Enter acts only on a control the keyboard was put on. Only its question is in the page's tab order and the walk is
 * its own, so no Tab can land on a choice, even one pressed as the ask arrives. Once it is answered the keyboard goes
 * back to the field, so the next key cannot land on the ask that takes its place.
 */
export function ComposerAsk({
  asks,
  label = "Waiting on you",
  blocked,
  continues,
  fieldHasWords,
  focusField,
}: {
  asks: WaitingAsk[];
  label?: string | undefined;
  blocked: string | null;
  continues?: ((approvalId: string) => string | null) | undefined;
  fieldHasWords: boolean;
  focusField: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const motion = useDockMotion(asks[0]);
  const ask = motion.shown;
  const shown = asks[0]?.block.approvalId;
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
      <AskContinues.Provider value={continues ?? noContinuation}>
        <div ref={motion.dock} className="composer-ask-dock" inert={motion.leaving || undefined}>
          <div
            ref={root}
            role="group"
            aria-label={label}
            className="composer-ask"
            data-ask={ask.block.approvalKind === "user_input" ? "question" : "approval"}
            data-landing={landing || undefined}
            onKeyDown={askKeyDown(focusField)}
            onKeyDownCapture={hold}
            onClickCapture={hold}
          >
            {ask.block.approvalKind === "user_input" ? (
              <QuestionAsk key={ask.block.approvalId} ask={ask} more={asks.length - 1} fieldHasWords={fieldHasWords} onStep={focusField} />
            ) : (
              <ApprovalAsk key={ask.block.approvalId} ask={ask} more={asks.length - 1} fieldHasWords={fieldHasWords} />
            )}
          </div>
        </div>
      </AskContinues.Provider>
    </AnswersBlocked.Provider>
  );
}

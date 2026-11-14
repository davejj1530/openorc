import { askKeyAct, askKeyName, type AskPlace, type WaitingAsk } from "@openorc/client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { AnswersBlocked } from "./ask-answer";
import { QuestionAsk } from "./QuestionCard";

/** Where the keyboard is in the ask, read from the control that has it. */
function placeOf(node: Element | null): AskPlace | null {
  switch (node?.getAttribute("data-ask-control")) {
    case "head":
      return "head";
    case "choice":
      return "choice";
    case "action":
      return "action";
    case "line":
      return (node as HTMLInputElement).value ? "lineText" : "lineEmpty";
    default:
      return null;
  }
}

/** The ask's controls in the order the keyboard walks them: down the ask from its question, the quiet ways out last. */
function walk(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>("[data-ask-control]")].filter((node) => !(node as HTMLButtonElement).disabled);
  return [...all.filter((node) => !node.hasAttribute("data-ask-last")), ...all.filter((node) => node.hasAttribute("data-ask-last"))];
}

/**
 * The ask an agent waits on, docked at the top of the composer's own piece above a hairline. One shows, and says how
 * many more wait. Its keys follow `askKeyAct`: the keyboard enters at its question only by the person's own key, and
 * Enter acts only on a control the keyboard was put on. Its controls stay out of the page's tab order and the walk is
 * its own, so no Tab can land on a choice, even one pressed as the ask arrives. Once it is answered the keyboard goes back to the field, so the
 * next key cannot land on the ask that takes its place.
 */
export function ComposerAsk({ asks, blocked, fieldHasWords, focusField }: { asks: WaitingAsk[]; blocked: string | null; fieldHasWords: boolean; focusField: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const ask = asks[0];
  const shown = ask?.block.approvalId;
  const last = useRef(shown);
  useEffect(() => {
    if (last.current === shown) return;
    last.current = shown;
    const focused = document.activeElement;
    if (!focused || focused === document.body || root.current?.contains(focused)) focusField();
  }, [shown, focusField]);
  if (!ask) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const place = placeOf(event.target as Element);
    const key = askKeyName(event);
    if (!place || !key) return;
    const act = askKeyAct(place, key, true);
    if (act === "pass") return;
    // The key is the field's: it lands there, as typed.
    if (act === "typeThrough") return focusField();
    event.preventDefault();
    const target = event.target as HTMLElement;
    const controls = walk(event.currentTarget);
    const at = controls.indexOf(target);
    if (act === "next" && controls[at + 1]) controls[at + 1]!.focus();
    else if (act === "next" || act === "leave") focusField();
    else if (act === "prev") controls[at - 1]?.focus();
    else if (act === "press") target.click();
    else if (act === "lineSend") target.closest("[data-ask-line]")?.querySelector<HTMLElement>("[data-ask-send]")?.click();
  };

  return (
    <AnswersBlocked.Provider value={blocked}>
      <div ref={root} role="group" aria-label="Waiting on you" className="composer-ask" data-ask={ask.block.approvalKind === "user_input" ? "question" : "approval"} onKeyDown={onKeyDown}>
        <QuestionAsk key={shown} ask={ask} more={asks.length - 1} fieldHasWords={fieldHasWords} />
      </div>
    </AnswersBlocked.Provider>
  );
}

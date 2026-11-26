import { askKeyAct, askKeyName, type AskPlace } from "@openorc/client";
import { type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronLeft } from "./icons";
import { Button, IconButton } from "./ui";

/**
 * A waiting ask's top: what it asks, alone across the dock's width beside its mark, and where the keyboard enters it.
 * The mark keeps its column whether or not there is one, so the words under it line up down the ask.
 */
export function AskTop({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <div className="composer-ask-top">
      <span className="composer-ask-mark">{mark}</span>
      <div className="composer-ask-head" tabIndex={0} data-ask-control="head">
        {children}
      </div>
    </div>
  );
}

/**
 * A waiting ask's one line under its body, which never scrolls away. At its start, where the ask stands: a step back
 * and its count among several questions, then how many more asks wait. At its end, its quiet ways out ("Decline" or
 * "Deny"), then its ways on.
 */
export function AskFoot({ back, count, more, ways, children }: { back?: ReactNode; count?: string | undefined; more: number; ways: ReactNode; children?: ReactNode }) {
  return (
    <div className="composer-ask-row">
      <span className="composer-ask-where">
        <span className="composer-ask-mark">{back}</span>
        {count ? <span className="composer-ask-count tabular">{count}</span> : null}
        {more > 0 ? <span className="composer-ask-count tabular">{more === 1 ? "1 more waits" : `${more} more wait`}</span> : null}
      </span>
      <span className="composer-ask-ways">
        {ways}
        {children}
      </span>
    </div>
  );
}

/** A quiet way out of an ask, last in the keyboard's walk though it is drawn before the ways on. */
export function AskWay({ children, disabled, tip, onClick }: { children: ReactNode; disabled: boolean; tip: string | undefined; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="focus-ring" tabIndex={-1} data-ask-control="action" data-ask-last="" disabled={disabled} data-tip={tip} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The step back to the question before, centred on the marks' column of the ask's row. */
export function AskBack({ disabled, tip, onClick }: { disabled: boolean; tip: string | undefined; onClick: () => void }) {
  return (
    <IconButton size="xs" className="focus-ring" aria-label="Previous question" tabIndex={-1} data-ask-control="action" data-ask-last="" disabled={disabled} data-tip={tip} onClick={onClick}>
      <ChevronLeft size={14} />
    </IconButton>
  );
}

/** A choice's mark: a ring, and an ink check once its row is picked. */
export function AskRing() {
  return (
    <span className="composer-ask-ring">
      <Check size={10} />
    </span>
  );
}

/**
 * The ask's own line for words: an answer of the person's own, or what to do instead. It is one more row of the ask,
 * its words in the words' column and a choice's ring before them where it stands among choices. The words go only by
 * its pill or Enter in it, and the pill shows only while it has words to take; it is the column's ink unless the field
 * below holds words. A line kept among several choices wears a picked choice's check.
 */
export function AskLine({
  label,
  placeholder,
  secret,
  mark,
  picked = false,
  value,
  onChange,
  send,
  disabled,
  tip,
}: {
  label: string;
  placeholder: string;
  secret: boolean;
  mark?: ReactNode;
  picked?: boolean;
  value: string;
  onChange: (value: string) => void;
  send: { words: string; ink: boolean; onSend: () => void; tip?: string | undefined } | null;
  disabled: boolean;
  tip: string | undefined;
}) {
  return (
    <label className="composer-ask-line" data-ask-line="" data-picked={picked || undefined}>
      <span className="composer-ask-mark">{mark}</span>
      <input
        type={secret ? "password" : "text"}
        className="native-field"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={value}
        tabIndex={-1}
        disabled={disabled}
        data-tip={tip}
        data-ask-control="line"
        onChange={(event) => onChange(event.target.value)}
      />
      {send ? (
        <Button size="sm" variant={send.ink ? "primary" : "secondary"} tabIndex={-1} data-ask-send="" disabled={disabled} data-tip={send.tip} onClick={send.onSend}>
          {send.words}
        </Button>
      ) : null}
    </label>
  );
}

/** Why the last answer did not go: the ask stays, and can be answered again. */
export function AskError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="composer-ask-error">
      {error}
    </p>
  ) : null;
}

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
 * The keys of a waiting ask, by `askKeyAct`: arrows and Tab walk its controls, Enter and Space press the one the
 * keyboard is on, Escape and a letter go back to the field. `focusField` is where the keyboard goes back to.
 */
export function askKeyDown(focusField: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
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
}

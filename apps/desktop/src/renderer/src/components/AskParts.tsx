import { askKeyAct, askKeyName, type AskPlace } from "@openorc/client";
import { type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./ui";

/**
 * A waiting ask's top line: what it asks, where the keyboard enters it, then how many more wait, and last its one quiet
 * way out ("Decline" or "Deny").
 */
export function AskTop({ mark, more, count, children, way }: { mark: ReactNode; more: number; count?: string | undefined; children: ReactNode; way: ReactNode }) {
  return (
    <div className="composer-ask-top">
      <span className="composer-ask-head" tabIndex={0} data-ask-control="head">
        {mark}
        <span className="min-w-0">{children}</span>
      </span>
      <span className="composer-ask-end">
        {count ? <span className="composer-ask-count tabular">{count}</span> : null}
        {more > 0 ? <span className="composer-ask-count tabular">{more === 1 ? "1 more waits" : `${more} more wait`}</span> : null}
        {way}
      </span>
    </div>
  );
}

/** The quiet way out of an ask, last in the keyboard's walk though it is drawn in the top line. */
export function AskWay({ children, disabled, tip, onClick }: { children: ReactNode; disabled: boolean; tip: string | undefined; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="focus-ring" tabIndex={-1} data-ask-control="action" data-ask-last="" disabled={disabled} data-tip={tip} onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * The ask's own line for words: an answer of the person's own, or what to do instead. The words go only by its pill or
 * Enter in it, and the pill shows only while it has words to take; it is the column's ink unless the field below holds
 * words. A line kept among several choices wears a picked choice's edge.
 */
export function AskLine({
  label,
  placeholder,
  secret,
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
  picked?: boolean;
  value: string;
  onChange: (value: string) => void;
  send: { words: string; ink: boolean; onSend: () => void; tip?: string | undefined } | null;
  disabled: boolean;
  tip: string | undefined;
}) {
  return (
    <label className="composer-ask-line" data-ask-line="" data-picked={picked || undefined}>
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

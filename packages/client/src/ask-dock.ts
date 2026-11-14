import { readQuestions } from "./approval-request.js";
import type { Block } from "./transcript.js";

/**
 * What every key does on a composer with an ask docked onto it, as one table. The composer's field and the ask's own
 * controls both read it, so the two can never disagree. It holds to three rules:
 *   1. Words typed in the composer's field are always a message. They never answer or deny an ask.
 *   2. The keyboard is in one place at a time: the field, a control of the ask, or the ask's own line. It moves only by
 *      the person's own key or press. An ask that arrives never takes it.
 *   3. Enter acts on the ask only where the person put the keyboard on purpose: on one of its controls, or in its own
 *      line with words in it. The keyboard enters an ask at its question, never at a choice, so arrow up then Enter
 *      answers nothing.
 */

/** Where the keyboard is. */
export type AskPlace =
  /** The composer's field, empty. */
  | "fieldEmpty"
  /** The field, with words. */
  | "fieldText"
  /** The field, with its `@` or `/` list open. */
  | "fieldList"
  /** The ask's question, where the keyboard enters it. */
  | "head"
  /** One of its choices. */
  | "choice"
  /** One of its buttons: Answer, Next, the allows, Deny, Decline, the request on demand. */
  | "action"
  /** Its own line for words, empty. */
  | "lineEmpty"
  /** Its own line, with words. */
  | "lineText";

export type AskKey = "Enter" | "Shift+Enter" | "Cmd+Enter" | "Escape" | "ArrowUp" | "ArrowDown" | "Tab" | "Shift+Tab" | "Space" | "letter";

/**
 * What a key does:
 *   pass         the key keeps its own meaning where it is: the field types, sends or picks from its list, the line types,
 *                Tab leaves for the composer's bar
 *   none         nothing at all
 *   enter        into the ask, onto its question
 *   next, prev   to the ask's control after or before; past the last, back to the field
 *   leave        back to the field
 *   press        the control under the keyboard, as a press would
 *   typeThrough  back to the field, where the key types
 *   lineSend     the words in the ask's own line answer it, or go with its denial
 */
export type AskAct = "pass" | "none" | "enter" | "next" | "prev" | "leave" | "press" | "typeThrough" | "lineSend";

const NAMED: Record<string, AskKey> = {
  Enter: "Enter",
  "Shift+Enter": "Shift+Enter",
  "Shift+Cmd+Enter": "Shift+Enter",
  "Cmd+Enter": "Cmd+Enter",
  Tab: "Tab",
  "Shift+Tab": "Shift+Tab",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  " ": "Space",
  "Shift+ ": "Space",
};

/** A key as the table names it, or null for one it has no row for (a modifier alone, a function key). */
export function askKeyName(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): AskKey | null {
  const command = event.metaKey || event.ctrlKey;
  const named = NAMED[`${event.shiftKey ? "Shift+" : ""}${command ? "Cmd+" : ""}${event.key}`];
  if (named) return named;
  return event.key.length === 1 && !command && !event.altKey ? "letter" : null;
}

const FIELD: Record<AskKey, AskAct> = {
  Enter: "pass",
  "Shift+Enter": "pass",
  // Send now is dimmed while an ask waits, so the other way has nothing to do.
  "Cmd+Enter": "none",
  Escape: "none",
  ArrowUp: "pass",
  ArrowDown: "pass",
  Tab: "pass",
  "Shift+Tab": "enter",
  Space: "pass",
  letter: "pass",
};

const HEAD: Record<AskKey, AskAct> = {
  Enter: "none",
  "Shift+Enter": "none",
  "Cmd+Enter": "none",
  Escape: "leave",
  ArrowUp: "none",
  ArrowDown: "next",
  Tab: "next",
  "Shift+Tab": "pass",
  Space: "none",
  letter: "typeThrough",
};

const CONTROL: Record<AskKey, AskAct> = { ...HEAD, Enter: "press", Space: "press", ArrowUp: "prev", "Shift+Tab": "prev" };

const LINE: Record<AskKey, AskAct> = { ...CONTROL, Enter: "none", Space: "pass", letter: "pass" };

const TABLE: Record<AskPlace, Record<AskKey, AskAct>> = {
  fieldEmpty: { ...FIELD, Enter: "none", ArrowUp: "enter", ArrowDown: "none" },
  fieldText: FIELD,
  fieldList: { ...FIELD, Escape: "pass", "Shift+Tab": "none" },
  head: HEAD,
  choice: CONTROL,
  action: CONTROL,
  lineEmpty: LINE,
  lineText: { ...LINE, Enter: "lineSend" },
};

/**
 * What a key does where the keyboard is. With no ask docked the field keeps every key's own meaning; the ask's places
 * exist only while one is docked.
 */
export function askKeyAct(place: AskPlace, key: AskKey, docked: boolean): AskAct {
  if (!docked) return "pass";
  return TABLE[place][key];
}

type ApprovalBlock = Extract<Block, { kind: "approval" }>;

/** An ask the agent waits on, with the run it belongs to, which its answer goes to. */
export interface WaitingAsk {
  runId: string;
  block: ApprovalBlock;
}

/** Which asks dock onto the composer; the rest stay where they were asked in the conversation. */
export function docks(block: ApprovalBlock): boolean {
  return block.approvalKind !== "user_input" || readQuestions(block.input).length > 0;
}

/** The asks a conversation waits on that dock onto its composer, the oldest first: it shows, the rest wait behind it. */
export function waitingAsks(run: { runId: string; blocks: readonly Block[] } | null | undefined): WaitingAsk[] {
  if (!run) return [];
  return run.blocks.flatMap((block) => (block.kind === "approval" && !block.decision && docks(block) ? [{ runId: block.runId ?? run.runId, block }] : []));
}

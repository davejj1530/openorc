import { describe, expect, it } from "vitest";
import { askKeyAct, askKeyName, waitingAsks, type AskKey, type AskPlace } from "./ask-dock.js";
import type { Block } from "./transcript.js";

const KEYS: AskKey[] = ["Enter", "Shift+Enter", "Cmd+Enter", "Escape", "ArrowUp", "ArrowDown", "Tab", "Shift+Tab", "Space", "letter"];
const FIELD: AskPlace[] = ["fieldEmpty", "fieldText", "fieldList"];
const ANSWERS = new Set(["press", "lineSend"]);

describe("the keys of a docked ask", () => {
  it("never lets a key in the composer's field answer or deny the ask", () => {
    for (const place of FIELD) for (const key of KEYS) expect([place, key, ANSWERS.has(askKeyAct(place, key, true))]).toEqual([place, key, false]);
  });

  it("enters the ask at its question, where Enter, Space and arrow up do nothing", () => {
    expect([askKeyAct("fieldEmpty", "ArrowUp", true), askKeyAct("fieldText", "Shift+Tab", true)]).toEqual(["enter", "enter"]);
    expect(["Enter", "Space", "ArrowUp", "Shift+Enter", "Cmd+Enter"].map((key) => askKeyAct("head", key as AskKey, true))).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("answers only from a control the keyboard was put on, or the ask's own line with words in it", () => {
    const answering = (["head", "choice", "action", "lineEmpty", "lineText"] as AskPlace[]).flatMap((place) =>
      KEYS.filter((key) => ANSWERS.has(askKeyAct(place, key, true))).map((key) => `${place} ${key}`),
    );
    expect(answering).toEqual(["choice Enter", "choice Space", "action Enter", "action Space", "lineText Enter"]);
  });

  it("does nothing with Enter in an empty field while an ask waits, and queues words typed there as a message", () => {
    expect([askKeyAct("fieldEmpty", "Enter", true), askKeyAct("fieldText", "Enter", true), askKeyAct("fieldText", "Cmd+Enter", true)]).toEqual(["none", "pass", "none"]);
  });

  it("leaves every key alone when nothing is docked", () => {
    for (const key of KEYS) expect(askKeyAct("fieldEmpty", key, false)).toBe("pass");
  });

  it("names keys as the table does", () => {
    const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
      askKeyName({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    expect([key("Enter", { metaKey: true }), key("Enter", { ctrlKey: true }), key("Tab", { shiftKey: true }), key(" "), key("a"), key("a", { metaKey: true }), key("Shift")]).toEqual([
      "Cmd+Enter",
      "Cmd+Enter",
      "Shift+Tab",
      "Space",
      "letter",
      null,
      null,
    ]);
  });
});

describe("the asks a conversation waits on", () => {
  const question = (id: string, q: Record<string, unknown>, more: Partial<Block> = {}): Block =>
    ({ id, kind: "approval", approvalId: id, approvalKind: "user_input", input: { questions: [{ question: "Where?", ...q }] }, ...more }) as Block;
  const choices = { options: [{ label: "Downloads" }, { label: "Ask each time" }] };

  it("lists unanswered asks oldest first, each with the run its answer goes to", () => {
    const run = { runId: "run-2", blocks: [question("a", choices, { runId: "run-1" }), question("b", choices), question("c", choices, { decision: "allow" })] };
    expect(waitingAsks(run).map((ask) => [ask.block.approvalId, ask.runId])).toEqual([
      ["a", "run-1"],
      ["b", "run-2"],
    ]);
  });

  it("docks every question and every request, and leaves an ask with nothing to ask where it was asked", () => {
    const run = {
      runId: "r",
      blocks: [
        question("one", choices),
        question("several", { ...choices, multiSelect: true }),
        question("words", {}),
        { id: "empty", kind: "approval", approvalId: "empty", approvalKind: "user_input", input: { questions: [] } } as Block,
        { id: "cmd", kind: "approval", approvalId: "cmd", approvalKind: "command", input: { command: "ls" } } as Block,
      ],
    };
    expect(waitingAsks(run).map((ask) => ask.block.approvalId)).toEqual(["one", "several", "words", "cmd"]);
  });
});

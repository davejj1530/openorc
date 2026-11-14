import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { markPieces, type Mark, type MarkSources, type Piece } from "../../lib/message-marks";
import { holdAtCaret, unitsOf } from "./draft";
import { caretOf, messageOf, mountEditor, placeCaret, type } from "./testing";

afterEach(cleanup);

const sources: MarkSources = {
  commands: [{ name: "code-review", insert: true, prefix: "/" }],
  connectors: [{ name: "paper", title: "Paper", logo: null }],
  members: [{ key: "rini", name: "Rini" }],
  files: ["src/app.ts"],
};
const KINDS = ["skill", "connector", "member", "file", "person"] as const;
/** The marks the box draws, by kind and what each stands for, in order. */
const drawn = (field: HTMLElement) =>
  [...field.querySelectorAll<HTMLElement>("[data-skill], [data-connector], [data-member], [data-file], [data-person]")].map((mark) => {
    const kind = KINDS.find((each) => mark.dataset[each] !== undefined)!;
    return [kind, mark.dataset[kind]];
  });
const named = (mark: Mark) =>
  ({
    skill: () => (mark as { name: string }).name,
    connector: () => (mark as { connector: { name: string } }).connector.name,
    member: () => (mark as { key: string }).key,
    file: () => (mark as { path: string }).path,
    person: () => (mark as { id: string }).id,
  })[mark.kind]();
const expected = (text: string) => markPieces(text, sources).flatMap((piece) => (piece.mark ? [[piece.mark.kind, named(piece.mark)]] : []));

describe("the message and the draft", () => {
  const samples = [
    "",
    "plain words",
    "ask @Rini and @paper to /code-review src/app.ts now",
    "two lines\nwith /code-review\n\nand a blank one between",
    "@Rini\n@paper\n",
    "  spaced   out  ",
    "trailing mark /code-review ",
    "تحقق من /code-review الآن",
    "😀 @paper 😀",
  ];

  it.each(samples)("draws %j as its marks and gives it back unchanged", (text) => {
    const { field, setMessage } = mountEditor({ sources });
    setMessage(text);
    expect(messageOf(field)).toBe(text);
    expect(drawn(field)).toEqual(expected(text));
    // A message the draft hands back writes into an empty draft as the same draft again.
    const again = mountEditor({ sources, value: messageOf(field) });
    expect(drawn(again.field)).toEqual(drawn(field));
  });

  it("keeps the caret where it was in the message as marks land around it", () => {
    const { field } = mountEditor({ sources });
    type(field, "ask @Rini about /code-review today", 4);
    expect(caretOf(field)).toBe(4);
    placeCaret(field, "ask @Rini about /code-review".length);
    expect(caretOf(field)).toBe("ask @Rini about /code-review".length);
  });

  it("lets a name typed in full wait at the caret and land once the caret moves on", () => {
    const { field } = mountEditor({ sources });
    type(field, "please /code-review");
    expect(drawn(field)).toEqual([]);
    type(field, "please /code-review ");
    expect(drawn(field)).toEqual([["skill", "code-review"]]);
    placeCaret(field, "please /code-review".length);
    expect(drawn(field)).toEqual([["skill", "code-review"]]);
  });

  it("takes a mark whole when an edit cuts into it, and reads the words left as they now read", () => {
    const { field } = mountEditor({ sources });
    type(field, "ask @paper now");
    type(field, "ask @pape now", 0);
    expect(messageOf(field)).toBe("ask @pape now");
    expect(drawn(field)).toEqual([]);
  });
});

describe("holdAtCaret", () => {
  const skill: Piece = { text: "/code-review", mark: { kind: "skill", name: "code-review" } };
  it("leaves a new mark ending at the caret as words, and keeps one that was already a mark there", () => {
    const pieces = [{ text: "please " }, skill];
    expect(holdAtCaret(pieces, 19, unitsOf([{ text: "please /code-review" }]))).toEqual([{ text: "please " }, { text: "/code-review" }]);
    expect(holdAtCaret(pieces, 19, unitsOf(pieces))).toEqual(pieces);
    expect(holdAtCaret(pieces, 3, [])).toEqual(pieces);
    expect(holdAtCaret(pieces, null, [])).toEqual(pieces);
  });
});

import { expect, it } from "vitest";
import { phoneNote, tagRuns, tagWordAt } from "./note-draft";

const MARA = { id: "u-mara", name: "Mara Okafor" };
const MARA_SHORT = { id: "u-mara", name: "Mara" };
const THEO = { id: "u-theo", name: "Theo Laurent" };

it("posts a draft that tags someone as a note, with each name where it stands, and a draft that tags no one as a message", () => {
  expect(phoneNote("@Mara Okafor and @Theo Laurent, look at the footer", [MARA, THEO])).toEqual({
    text: "@Mara Okafor and @Theo Laurent, look at the footer",
    mentions: [
      { userId: "u-mara", start: 0, end: 12 },
      { userId: "u-theo", start: 17, end: 30 },
    ],
  });
  // A tag whose words were deleted tags no one.
  expect(phoneNote("look at the footer", [MARA])).toBeNull();
  expect(phoneNote("plain words", [])).toBeNull();
});

it("reads the longer of two names that start alike, and keeps the server's own words for a tagged person", () => {
  expect(phoneNote("@Mara Okafor hi", [MARA_SHORT, MARA])?.mentions).toEqual([{ userId: "u-mara", start: 0, end: 12 }]);
  expect(phoneNote("@Mara can you retry the save?", [MARA_SHORT])).toEqual({ text: "@Mara can you retry the save?", mentions: [{ userId: "u-mara", start: 0, end: 5 }] });
});

it("answers the note it replies to only while it still tags that note's author", () => {
  const reply = { noteId: "n1", authorId: "u-mara" };
  expect(phoneNote("@Mara Okafor done", [MARA], reply)?.replyTo).toBe("n1");
  expect(phoneNote("@Theo Laurent done", [MARA, THEO], reply)?.replyTo).toBeUndefined();
});

it("finds the @ word at the caret, only at a word's start and before any space", () => {
  expect(tagWordAt("hi @Ma", 6)).toEqual({ start: 3, query: "Ma" });
  expect(tagWordAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(tagWordAt("mail@host", 9)).toBeNull();
  expect(tagWordAt("@Mara Okafor", 12)).toBeNull();
});

it("runs each standing tag's words apart for the mention ink", () => {
  expect(tagRuns("ok @Mara Okafor, then @Theo", [MARA, THEO])).toEqual([
    { text: "ok ", tag: false },
    { text: "@Mara Okafor", tag: true },
    { text: ", then @Theo", tag: false },
  ]);
});

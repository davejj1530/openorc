import { describe, expect, it } from "vitest";
import { noteFromDraft, personTag, tagsPerson } from "./note-draft.js";

const MARA = { id: "u-mara", name: "Mara Okafor" };
const THEO = { id: "u-theo", name: "Theo Laurent" };

describe("a draft that tags a person, as the note it posts", () => {
  it("is a note only when it holds a structured tag; a typed @Name is only words", () => {
    expect(tagsPerson(`${personTag("u-mara")} the columns match`)).toBe(true);
    expect(tagsPerson("@Mara the columns match")).toBe(false);
  });

  it("writes each tag out as the person's name and says where it stands", () => {
    expect(noteFromDraft(`${personTag("u-mara")} The columns match. Keep the date first.`, [MARA])).toEqual({
      text: "@Mara Okafor The columns match. Keep the date first.",
      mentions: [{ userId: "u-mara", start: 0, end: 12 }],
    });
  });

  it("counts places in UTF-16 units past emoji, keeps tags in order and trims the ends", () => {
    const draft = `  😀 ${personTag("u-theo")} and ${personTag("u-mara")}, look  `;
    expect(noteFromDraft(draft, [MARA, THEO])).toEqual({
      text: "😀 @Theo Laurent and @Mara Okafor, look",
      mentions: [
        { userId: "u-theo", start: 3, end: 16 },
        { userId: "u-mara", start: 21, end: 33 },
      ],
    });
  });

  it("posts nothing when a tag names nobody it knows, or nothing is tagged", () => {
    expect(noteFromDraft(`${personTag("u-gone")} look`, [MARA])).toBeNull();
    expect(noteFromDraft("plain words", [MARA])).toBeNull();
  });
});

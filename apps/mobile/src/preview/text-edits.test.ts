import { expect, it } from "vitest";
import { textEdits } from "./text-edits";

it("sends what was typed after what the Mac already has", () => {
  expect(textEdits("", "Hello")).toEqual([{ kind: "text", text: "Hello" }]);
  expect(textEdits("Hello", "Hello, wörld")).toEqual([{ kind: "text", text: ", wörld" }]);
  expect(textEdits("same", "same")).toEqual([]);
});

it("turns a deletion into Backspaces and a replacement, as autocorrect makes, into both", () => {
  expect(textEdits("Hello", "Help")).toEqual([
    { kind: "key", key: "Backspace", count: 2 },
    { kind: "text", text: "p" },
  ]);
  expect(textEdits("teh ", "the ")).toEqual([
    { kind: "key", key: "Backspace", count: 3 },
    { kind: "text", text: "he " },
  ]);
  expect(textEdits("abc", "")).toEqual([{ kind: "key", key: "Backspace", count: 3 }]);
});

it("deletes a character the way the Mac counts it, an emoji as one, and never splits one", () => {
  expect(textEdits("ok 👍", "ok ")).toEqual([{ kind: "key", key: "Backspace", count: 1 }]);
  expect(textEdits("x👍", "x👎")).toEqual([
    { kind: "key", key: "Backspace", count: 1 },
    { kind: "text", text: "👎" },
  ]);
});

it("breaks a line with Return, which a field takes as Enter", () => {
  expect(textEdits("ab", "ab\ncd\n")).toEqual([
    { kind: "key", key: "Enter", count: 1 },
    { kind: "text", text: "cd" },
    { kind: "key", key: "Enter", count: 1 },
  ]);
});

it("sends a long paste in pieces of 1,000 characters", () => {
  const pasted = "a".repeat(2500);
  expect(textEdits("", pasted)).toEqual([
    { kind: "text", text: "a".repeat(1000) },
    { kind: "text", text: "a".repeat(1000) },
    { kind: "text", text: "a".repeat(500) },
  ]);
});

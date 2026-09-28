import { describe, expect, it } from "vitest";
import { skillSegments } from "./skill-tokens";

const names = new Set(["formatting", "code-review", "figma", "figma:figma-use"]);
const marked = (text: string): string[] =>
  skillSegments(text, names)
    .filter((s) => s.skill)
    .map((s) => s.text);
const rebuilt = (text: string): string =>
  skillSegments(text, names)
    .map((s) => s.text)
    .join("");

describe("skill tokens", () => {
  it("marks a name the project has and leaves one it does not", () => {
    expect(marked("/formatting please")).toEqual(["/formatting"]);
    expect(marked("/not-a-skill please")).toEqual([]);
  });

  it("takes the longest name, so a plugin skill is not cut short by its plugin", () => {
    expect(marked("/figma:figma-use")).toEqual(["/figma:figma-use"]);
    expect(marked("/figma on its own")).toEqual(["/figma"]);
  });

  it("only counts a token that starts a word", () => {
    expect(marked("see http://x/formatting for it")).toEqual([]);
    expect(marked("src//formatting")).toEqual([]);
    expect(marked("run /formatting now")).toEqual(["/formatting"]);
    expect(marked("/formatting")).toEqual(["/formatting"]);
  });

  it("does not match a longer word that merely starts with a name", () => {
    expect(marked("/formattings")).toEqual([]);
    expect(marked("/code-review-2")).toEqual([]);
    expect(marked("/code-review.")).toEqual(["/code-review"]);
  });

  it("marks every occurrence, across lines", () => {
    expect(marked("/formatting then\n/code-review")).toEqual(["/formatting", "/code-review"]);
  });

  it("marks Codex dollar invocations without marking Claude slash invocations", () => {
    expect(
      skillSegments("$code-review then /code-review", names, "$")
        .filter((segment) => segment.skill)
        .map((segment) => segment.text),
    ).toEqual(["$code-review"]);
  });

  it("never loses or invents a character", () => {
    for (const text of ["", "plain", "/formatting", " /formatting ", "a /figma b /code-review c", "///", "/formatting/formatting"]) {
      expect(rebuilt(text)).toBe(text);
    }
  });

  it("returns the whole message unmarked when the project has no skills", () => {
    expect(skillSegments("/formatting", new Set())).toEqual([{ text: "/formatting", skill: false }]);
    expect(skillSegments("", names)).toEqual([]);
  });
});

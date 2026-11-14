import { expect, it } from "vitest";
import { titleFromPrompt } from "./thread-title.js";

it("uses the first nonblank line and the empty-conversation name", () => {
  expect(titleFromPrompt(" \n  Add CSV export  \nwith filters")).toBe("Add CSV export");
  expect(titleFromPrompt(" \n\t")).toBe("New thread");
});

it("cuts at code points and masks whole secrets before cutting", () => {
  expect(titleFromPrompt(`${"a".repeat(70)}🚀🚀`)).toBe(`${"a".repeat(70)}🚀🚀`);
  expect(titleFromPrompt(`${"a".repeat(70)}🚀🚀 extra`)).toBe(`${"a".repeat(70)}🚀…`);
  expect(titleFromPrompt(`${"a".repeat(70)}  extra`)).toBe(`${"a".repeat(70)}…`);
  expect(titleFromPrompt(`${"a".repeat(50)} ghp_${"b".repeat(36)} to push`)).toBe(`${"a".repeat(50)} [redacted:github-tok…`);
});

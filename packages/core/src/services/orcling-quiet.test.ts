import { expect, it } from "vitest";
import { isQuietReply, mayBeQuiet } from "./orcling-quiet.js";

it("takes the quiet word however a model wraps it, and nothing that only starts like it", () => {
  for (const text of ["NO_REPLY", " NO_REPLY\n", "`NO_REPLY`", "**NO_REPLY**", '"NO_REPLY".']) expect(isQuietReply(text), text).toBe(true);
  for (const text of ["", "NO", "NO_REPLY needed here", "no_reply", "Nope"]) expect(isQuietReply(text), text).toBe(false);
});

it("holds back streamed text only while it could still become the quiet word", () => {
  for (const text of ["", " ", "N", "NO_", "`NO_REP", "NO_REPLY", "NO_REPLY`"]) expect(mayBeQuiet(text), text).toBe(true);
  for (const text of ["Nope", "Hey", "NO_REPLY is what I", "No, "]) expect(mayBeQuiet(text), text).toBe(false);
});

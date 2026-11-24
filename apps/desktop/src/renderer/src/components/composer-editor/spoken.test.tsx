import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { caretOf, messageOf, mountEditor, type } from "./testing";

afterEach(cleanup);

it("writes spoken words at the caret with a space on either side, rewriting them as more is heard", () => {
  const { field, handle } = mountEditor();
  type(field, "Start end", 5);
  const spoken = handle.current!.speak();
  act(() => spoken.say("open the"));
  act(() => spoken.say("Open the file."));
  expect(messageOf(field)).toBe("Start Open the file. end");
  expect(caretOf(field)).toBe("Start Open the file.".length);
});

it("takes the words back out when the recording is cancelled, and leaves a selection alone when nothing was heard", () => {
  const { field, handle } = mountEditor();
  type(field, "Keep this.");
  const spoken = handle.current!.speak();
  act(() => spoken.say("Not this"));
  expect(messageOf(field)).toBe("Keep this. Not this");
  act(() => spoken.end(false));
  expect(messageOf(field)).toBe("Keep this.");
  const silent = handle.current!.speak();
  act(() => {
    silent.say("");
    silent.end(true);
  });
  expect(messageOf(field)).toBe("Keep this.");
});

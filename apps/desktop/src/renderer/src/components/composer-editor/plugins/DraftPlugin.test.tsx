import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { caretOf, messageOf, mountEditor, press, type } from "../testing";

afterEach(cleanup);

it("writes a message from outside with the caret at its end, and reports it as no edit of the person's", () => {
  const { field, changes, setMessage } = mountEditor({ value: "a saved draft" });
  expect(messageOf(field)).toBe("a saved draft");
  setMessage("came back after a failed send");
  expect(messageOf(field)).toBe("came back after a failed send");
  expect(caretOf(field)).toBe("came back after a failed send".length);
  expect(changes.some((change) => change.edited)).toBe(false);
});

it("reports the person's edits with their caret, and no caret while they are elsewhere", () => {
  const { field, changes, setMessage } = mountEditor();
  type(field, "typed by hand", 5);
  expect(changes.at(-1)).toEqual({ text: "typed by hand", caret: 5, edited: true });
  act(() => field.blur());
  setMessage("written from outside");
  expect(changes.at(-1)).toEqual({ text: "written from outside", caret: null, edited: false });
});

it("starts a fresh undo history when a send clears the message, so Undo never brings a sent message back", () => {
  const { field, setMessage } = mountEditor();
  type(field, "sent already");
  setMessage("");
  press(field, { key: "z", ctrlKey: true });
  expect(messageOf(field)).toBe("");
});

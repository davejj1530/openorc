import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { messageOf, mountEditor, press, type } from "../testing";

afterEach(cleanup);

it("hands keys to the composer first, and leaves the editor a key the composer did not take", () => {
  const onKeyDown = vi.fn((event: KeyboardEvent) => event.key === "Enter" && !event.shiftKey);
  const { field } = mountEditor({ onKeyDown });
  type(field, "first");
  press(field, { key: "Enter" });
  expect(messageOf(field)).toBe("first");
  press(field, { key: "Enter", shiftKey: true });
  expect(messageOf(field)).toBe("first\n");
  expect(onKeyDown.mock.calls.map(([event]) => [event.key, event.shiftKey])).toEqual([
    ["Enter", false],
    ["Enter", true],
  ]);
});

it.each([
  ["while an input method composes", (field: HTMLElement) => fireEvent.compositionStart(field, { data: "に" })],
  ["for the key that ends a composition", () => {}],
])("never hands Enter to the composer %s", (_when, start) => {
  const onKeyDown = vi.fn(() => true);
  const { field } = mountEditor({ onKeyDown });
  type(field, "にほん");
  start(field);
  press(field, { key: "Enter", keyCode: 229 });
  press(field, { key: "Enter", isComposing: true });
  expect(onKeyDown).not.toHaveBeenCalled();
});

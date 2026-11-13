import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { caretOf, mountEditor } from "../testing";

afterEach(cleanup);

it("takes focus as it mounts with the caret after the draft it opens with, and only when asked", async () => {
  const { field } = mountEditor({ value: "a kept draft", autoFocus: true });
  await act(async () => {});
  expect(document.activeElement).toBe(field);
  expect(caretOf(field)).toBe("a kept draft".length);
  cleanup();
  const other = mountEditor({ value: "a kept draft" });
  await act(async () => {});
  expect(document.activeElement).not.toBe(other.field);
});

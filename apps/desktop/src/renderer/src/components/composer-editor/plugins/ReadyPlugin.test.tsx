import { act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountEditor, type } from "../testing";

afterEach(cleanup);

it("says ready as the person focuses the message and as they start one, and not for more words or a message from outside", () => {
  const onReady = vi.fn();
  const { field, setMessage } = mountEditor({ onReady });
  act(() => field.focus());
  expect(onReady).toHaveBeenCalledTimes(1);
  act(() => field.blur());
  setMessage("a saved draft");
  setMessage("");
  expect(onReady).toHaveBeenCalledTimes(1);
  type(field, "R");
  type(field, "Run it");
  expect(onReady).toHaveBeenCalledTimes(3);
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRowState } from "./row-state";

afterEach(cleanup);

it("keeps a row's state while the view shows it, and starts over for each row the list hands the view", () => {
  const view = renderHook(({ row }) => useRowState(row, () => "idle"), { initialProps: { row: "actions:a" } });
  const [, setForA] = view.result.current;
  act(() => setForA("copied"));
  view.rerender({ row: "actions:a" });
  expect(view.result.current[0]).toBe("copied");

  view.rerender({ row: "actions:b" });
  expect(view.result.current[0]).toBe("idle");
  act(() => view.result.current[1]("failed"));
  // A timer row A started still fires: it must not reach row B.
  act(() => setForA("idle"));
  expect(view.result.current[0]).toBe("failed");

  view.rerender({ row: "actions:a" });
  expect(view.result.current[0]).toBe("idle");
});

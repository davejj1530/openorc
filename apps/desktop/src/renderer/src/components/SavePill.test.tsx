import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SavePill } from "./SavePill";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("announces only an acknowledged save, confirms in place, then returns to Save", () => {
  vi.useFakeTimers();
  const view = render(<SavePill onSave={() => {}} disabled={false} pending savedAt={null} />);
  expect(screen.getByRole("status").textContent).toBe("");
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  view.rerender(<SavePill onSave={() => {}} disabled pending={false} savedAt={1} />);
  expect(screen.getByRole("status").textContent).toBe("Saved");
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1700);
  });
  expect(screen.getByRole("status").textContent).toBe("");
});

it("stays quiet when a save fails", () => {
  const view = render(<SavePill onSave={() => {}} disabled={false} pending savedAt={null} />);
  view.rerender(<SavePill onSave={() => {}} disabled={false} pending={false} savedAt={null} />);
  expect(screen.getByRole("status").textContent).toBe("");
});

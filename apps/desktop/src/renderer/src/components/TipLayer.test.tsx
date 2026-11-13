// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TipLayer } from "./TipLayer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mount = () =>
  render(
    <>
      <button data-tip="Start a new shell here">Restart</button>
      <span data-tip="Same words">Same words</span>
      <p>Elsewhere</p>
      <TipLayer />
    </>,
  );
const pass = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const tip = () => document.querySelector(".tooltip-popup-tip")?.textContent ?? null;

it("opens an element's data-tip after the tooltip delay and closes it when the pointer leaves", () => {
  mount();
  fireEvent.mouseOver(screen.getByText("Restart"));
  pass(700);
  expect(tip()).toBeNull();
  pass(150);
  expect(tip()).toBe("Start a new shell here");
  fireEvent.mouseOver(screen.getByText("Elsewhere"));
  pass(1000);
  expect(tip()).toBeNull();
});

it("follows the tip's words while it is open, and stays closed after a press until the pointer comes back", async () => {
  mount();
  const button = screen.getByText("Restart");
  fireEvent.mouseOver(button);
  pass(850);
  button.setAttribute("data-tip", "End this shell");
  await act(async () => {
    await Promise.resolve();
  });
  expect(tip()).toBe("End this shell");
  fireEvent.mouseDown(button);
  fireEvent.mouseOver(button);
  pass(1000);
  expect(tip()).toBeNull();
});

it("leaves a tip that only repeats the element's own uncut words closed", () => {
  mount();
  fireEvent.mouseOver(screen.getByText("Same words"));
  pass(1000);
  expect(tip()).toBeNull();
});

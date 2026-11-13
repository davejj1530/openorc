import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useComposerFit, type ComposerFit } from "./composer-fit";

/** A bar whose chips need `needs[step]` pixels at each step, in a row `room` wide. */
function bar(room: number, needs: Record<ComposerFit, number>) {
  const element = document.createElement("div");
  const tools = document.createElement("div");
  tools.className = "composer-tools";
  element.append(tools);
  Object.defineProperty(tools, "clientWidth", { get: () => room });
  Object.defineProperty(tools, "scrollWidth", { get: () => Math.max(room, needs[element.dataset.fit as ComposerFit]) });
  return element;
}

const needs = { whole: 320, "no-effort": 280, marks: 200, logos: 150 };

it("keeps every word while the chips fit, and gives them up a step at a time as the row narrows", () => {
  const fit = renderHook(() => useComposerFit()).result.current;
  for (const [room, step] of [
    [400, "whole"],
    [300, "no-effort"],
    [240, "marks"],
    [160, "logos"],
  ] as const) {
    const element = bar(room, needs);
    fit(element);
    expect(element.dataset.fit, `${room}px`).toBe(step);
  }
});

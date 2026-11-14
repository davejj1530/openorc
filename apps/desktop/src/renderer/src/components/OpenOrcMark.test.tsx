import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OpenOrcMark, WorkingCube } from "./OpenOrcMark";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("puts every working cube's faces on the document's clock, so cubes that appear later turn in step", () => {
  const faces: { startTime: number | null }[] = [];
  Object.defineProperty(SVGElement.prototype, "getAnimations", {
    configurable: true,
    value() {
      const own = [{ startTime: 812 }, { startTime: 812 }, { startTime: 812 }];
      faces.push(...own);
      return own;
    },
  });
  render(
    <>
      <WorkingCube />
      <OpenOrcMark size={24} working />
      <OpenOrcMark size={16} />
    </>,
  );
  expect(faces).toHaveLength(6);
  expect(faces.every((face) => face.startTime === 0)).toBe(true);
  delete (SVGElement.prototype as { getAnimations?: unknown }).getAnimations;
});

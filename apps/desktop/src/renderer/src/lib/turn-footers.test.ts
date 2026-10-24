import { describe, expect, it } from "vitest";
import { outsideAnchor } from "./turn-footers";

const block = (id: string, at: number, startsTurn = false) => ({ id, at, startsTurn });
const lastTurn = [block("ask", 10, true), block("reply", 11), block("done", 12)];

describe("outsideAnchor", () => {
  it("steps back over the prompt a new process recorded before the capture", () => {
    expect(outsideAnchor([...lastTurn, block("next-ask", 20, true)], 21)).toBe("done");
  });

  it("follows the previous turn when a live process captured before recording the prompt", () => {
    expect(outsideAnchor([...lastTurn, block("next-ask", 22, true)], 21)).toBe("done");
  });

  it("does not step back over a message that steered a running turn", () => {
    expect(outsideAnchor([block("ask", 10, true), block("reply", 11), block("steer", 12)], 13)).toBe("steer");
  });

  it("is null while the turn before the capture is not loaded", () => {
    expect(outsideAnchor([block("next-ask", 20, true), block("next-reply", 30)], 21)).toBeNull();
    expect(outsideAnchor([block("next-ask", 22, true), block("next-reply", 30)], 21)).toBeNull();
  });
});

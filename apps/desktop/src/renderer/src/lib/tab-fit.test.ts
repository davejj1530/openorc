import { describe, expect, it } from "vitest";
import { HEADING_MAX, tabsShown } from "./tab-fit";

const fixed = { tab: 140, more: 70, gap: 6 };

describe("tabsShown", () => {
  it("shows every other thread while each fits at its narrowest beside the whole heading", () => {
    expect(tabsShown({ ...fixed, room: 900, heading: 240, count: 3 })).toBe(3);
    expect(tabsShown({ ...fixed, room: 240 + 6 + 3 * 140, heading: 240, count: 3 })).toBe(3);
  });

  it("moves the tabs that do not fit into the menu, keeping room for its button", () => {
    // 600 - 240 - 6 = 354 for tabs; all three need 420, so the menu takes 70 and two tabs fit in the 284 left.
    expect(tabsShown({ ...fixed, room: 600, heading: 240, count: 3 })).toBe(2);
    expect(tabsShown({ ...fixed, room: 400, heading: 240, count: 6 })).toBe(0);
  });

  it("never lets the tabs take room from the heading's name, and caps the heading at its widest", () => {
    expect(tabsShown({ ...fixed, room: 300, heading: 290, count: 1 })).toBe(0);
    const wide = tabsShown({ ...fixed, room: HEADING_MAX + 6 + 2 * 140, heading: 2000, count: 2 });
    expect(wide).toBe(2);
  });

  it("shows nothing when no other thread is open", () => {
    expect(tabsShown({ ...fixed, room: 100, heading: 600, count: 0 })).toBe(0);
  });
});

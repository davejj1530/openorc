import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountGraceLine } from "./AccountGraceLine";

const until = new Date(2026, 10, 15, 14, 5).getTime();
const now = new Date(2026, 10, 14, 14, 5).getTime();
/** What the browser would measure: the room the line has, and the width the longer words need. */
const layout = { room: 200, needed: 160 };
let resized: (() => void)[] = [];
beforeEach(() => {
  resized = [];
  layout.room = 200;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(changed: () => void) {
        resized.push(changed);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => layout.room);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: layout.needed }) as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const shown = (container: HTMLElement) => [container.querySelector(".sidebar-account-grace")!.textContent];

it("says today or tomorrow with the time where the words fit, and keeps the full deadline on demand", () => {
  const { container } = render(<AccountGraceLine until={until} now={now} />);
  expect(shown(container)[0]).toMatch(/^Pro ends tomorrow at /);
  expect(container.querySelector("[data-tip]")?.getAttribute("data-tip")).toContain("2026");
  expect(container.querySelector("[title]")).toBeNull();
});

it("names the weekday and the time where the longer words would not fit, and takes them back when there is room", () => {
  layout.room = 150;
  const { container } = render(<AccountGraceLine until={until} now={now} />);
  expect(shown(container)[0]).toMatch(/^Pro ends Sun /);
  layout.room = 170;
  act(() => resized.forEach((changed) => changed()));
  expect(shown(container)[0]).toMatch(/^Pro ends tomorrow at /);
});

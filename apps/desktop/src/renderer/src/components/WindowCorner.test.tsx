import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { WindowCorner } from "./WindowCorner";

afterEach(cleanup);
beforeEach(() => {
  useRouter.setState({ route: { view: "newthread" }, history: [], future: [], threadIds: [] });
});

const labels = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
const back = () => screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;

it("holds nothing while the sidebar shows, whose header keeps the toggle, and the toggle with Back and Forward once it is hidden", () => {
  const { rerender } = render(<WindowCorner sidebarOpen />);
  expect(screen.queryAllByRole("button")).toEqual([]);
  rerender(<WindowCorner sidebarOpen={false} />);
  expect(labels()).toEqual(["Toggle sidebar", "Back", "Forward"]);
});

it("steps forward again after a step back, off while there is nowhere to go", () => {
  render(<WindowCorner sidebarOpen={false} />);
  const forward = () => screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
  expect(forward().disabled).toBe(true);
  act(() => useRouter.getState().navigate({ view: "tasks" }));
  fireEvent.click(back());
  expect(forward().disabled).toBe(false);
  fireEvent.click(forward());
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(forward().disabled).toBe(true);
});

it("steps back through the window's history, off while there is nowhere to go", () => {
  render(<WindowCorner sidebarOpen={false} />);
  expect(back().disabled).toBe(true);

  act(() => useRouter.getState().navigate({ view: "tasks" }));
  expect(back().disabled).toBe(false);

  fireEvent.click(back());
  expect(useRouter.getState().route).toEqual({ view: "newthread" });
  expect(back().disabled).toBe(true);
});

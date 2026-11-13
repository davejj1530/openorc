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
beforeEach(() => useRouter.setState({ route: { view: "newthread" }, history: [], future: [], threadIds: [] }));

const labels = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
const back = () => screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;

it("reads the sidebar toggle, then Back, with the sidebar open or hidden, and leaves Forward to the keyboard", () => {
  const { rerender } = render(<WindowCorner sidebarOpen={false} />);
  expect(labels()).toEqual(["Toggle sidebar", "Back"]);
  rerender(<WindowCorner sidebarOpen />);
  expect(labels()).toEqual(["Toggle sidebar", "Back"]);
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

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

import { WindowNav } from "./Sidebar";

afterEach(cleanup);
beforeEach(() => useRouter.setState({ route: { view: "newthread" }, history: [], future: [], threadIds: [] }));

const labels = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
const back = () => screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
const forward = () => screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;

it("reads Back, Forward, then the sidebar toggle, with the sidebar open or hidden", () => {
  const { rerender } = render(<WindowNav open={false} />);
  expect(labels()).toEqual(["Back", "Forward", "Toggle sidebar"]);
  rerender(<WindowNav open />);
  expect(labels()).toEqual(["Back", "Forward", "Toggle sidebar"]);
});

it("steps back and forward through the window's history, each off while there is nowhere to go", () => {
  render(<WindowNav open={false} />);
  expect(back().disabled).toBe(true);
  expect(forward().disabled).toBe(true);

  act(() => useRouter.getState().navigate({ view: "tasks" }));
  expect(back().disabled).toBe(false);
  expect(forward().disabled).toBe(true);

  fireEvent.click(back());
  expect(useRouter.getState().route).toEqual({ view: "newthread" });
  expect(back().disabled).toBe(true);
  expect(forward().disabled).toBe(false);

  fireEvent.click(forward());
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
  expect(forward().disabled).toBe(true);
});

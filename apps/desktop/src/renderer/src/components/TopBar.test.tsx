import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./Sidebar", () => ({ WindowNav: () => null }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/client", async (original) => ({ ...(await original<object>()), useRpc: () => ({ data: undefined }) }));

import { useLayout } from "../lib/layout";
import { TopBar } from "./TopBar";

afterEach(cleanup);

it("keeps the panel's toggle in the header both ways, so an open panel can be hidden from here", () => {
  useLayout.getState().setPanel(true);
  render(<TopBar panel>{null}</TopBar>);
  const toggle = screen.getByRole("button", { name: "Hide panel" });
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(toggle);
  expect(useLayout.getState().panelOpen).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  expect(useLayout.getState().panelOpen).toBe(true);
});

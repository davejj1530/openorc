import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { SettingsTitle } from "./Settings";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));

beforeEach(() => {
  useLayout.setState({ sidebarOpen: true });
  useRouter.setState({ route: { view: "settings" }, history: [], future: [] });
});
afterEach(cleanup);

it("names the open section, and lists the others from the title while the sidebar is hidden", async () => {
  render(<SettingsTitle current={{ id: "usage", label: "Usage" }} />);
  expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();

  act(() => useLayout.setState({ sidebarOpen: false }));
  fireEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Usage", "Connections", "Slack", "Skills", "Appearance", "General", "Memory & models", "Data"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Appearance" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "appearance" });
});

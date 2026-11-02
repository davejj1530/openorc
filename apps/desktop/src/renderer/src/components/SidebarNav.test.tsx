import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";

vi.mock("../lib/client", async (original) => {
  const rows: Record<string, unknown[]> = {
    "tasks.list": [{ status: "proposed" }, { status: "in_progress" }, { status: "review" }, { status: "backlog" }, { status: "done" }],
    "schedules.list": [{ enabled: true }, { enabled: false }],
  };
  return { ...(await original<object>()), useRpc: (method: string) => ({ data: rows[method] }) };
});

import { SidebarNav } from "./SidebarNav";

afterEach(cleanup);

const nav = () => screen.getByRole("navigation", { name: "Screens" });
/** The rows a person can reach: buttons outside a folded More. */
const listed = () =>
  within(nav())
    .getAllByRole("button")
    .map((button) => button.querySelector(".sidebar-nav-label")?.textContent);
const show = () => render(<SidebarNav route={useRouter.getState().route} projectId={null} />);

it("starts with New thread and More, keeping every optional screen folded under More", () => {
  expect(useLayout.getState().hiddenScreens).toEqual(["tasks", "pulls", "scheduled", "orchestration", "memory"]);
  show();
  expect(listed()).toEqual(["New thread", "More"]);

  const more = screen.getByRole("button", { name: "More" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(listed()).toEqual(["New thread", "More", "Tasks", "Pull requests", "Schedules", "Teams", "Memory", "Edit sidebar"]);
  expect(screen.getByRole("button", { name: /^Tasks/ }).querySelector(".sidebar-nav-count")?.textContent).toBe("3");
  expect(screen.getByRole("button", { name: /^Schedules/ }).querySelector(".sidebar-nav-count")?.textContent).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  expect(useRouter.getState().route).toEqual({ view: "memory" });
});

it("reads More as current while one of its screens is open and More is folded", () => {
  useRouter.setState({ route: { view: "orchestration" } });
  show();
  const more = screen.getByRole("button", { name: "More" });
  expect(more.getAttribute("aria-current")).toBe("page");
  fireEvent.click(more);
  expect(more.getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: "Teams" }).getAttribute("aria-current")).toBe("page");
});

it("edits which screens the sidebar lists in a dialog of switches, and remembers the choice", async () => {
  useRouter.setState({ route: { view: "newthread" } });
  show();
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit sidebar" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit sidebar" });
  expect(
    within(dialog)
      .getAllByRole("switch")
      .map((toggle) => [toggle.getAttribute("aria-label") ?? toggle.closest("label")?.textContent, (toggle as HTMLInputElement).checked]),
  ).toEqual([
    ["Tasks", false],
    ["Pull requests", false],
    ["Schedules", false],
    ["Teams", false],
    ["Memory", false],
  ]);
  fireEvent.click(within(dialog).getByRole("switch", { name: "Memory" }));
  fireEvent.click(within(dialog).getByRole("switch", { name: "Pull requests" }));
  fireEvent.click(within(dialog).getByRole("switch", { name: "Tasks" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // More stays unfolded, listing the screens that remain hidden.
  expect(listed()).toEqual(["New thread", "Tasks", "Pull requests", "Memory", "More", "Schedules", "Teams", "Edit sidebar"]);
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}").hiddenScreens).toEqual(["scheduled", "orchestration"]);
});

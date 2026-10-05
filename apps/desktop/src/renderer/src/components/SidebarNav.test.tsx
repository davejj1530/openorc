import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { SidebarNav } from "./SidebarNav";

vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
afterEach(cleanup);

const listed = () =>
  within(screen.getByRole("navigation"))
    .getAllByRole("button")
    .map((button) => button.textContent);
const show = () => render(<SidebarNav route={useRouter.getState().route} projectId={null} />);

it("lists Tasks and Schedules and keeps other destinations under More", async () => {
  expect(useLayout.getState().hiddenScreens).toEqual(["pulls", "orchestration", "memory"]);
  show();
  expect(listed()).toEqual(["Tasks", "Schedules", "More"]);

  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Pull requests", "Orchestration", "Memory", "Edit sidebar…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Memory" }));
  expect(useRouter.getState().route).toEqual({ view: "memory" });
});

it("reads More as current while one of its screens is open", () => {
  useRouter.setState({ route: { view: "orchestration" } });
  show();
  expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
});

it("edits which screens the sidebar lists, and remembers the choice", async () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit sidebar…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit sidebar" });
  fireEvent.click(within(dialog).getByRole("switch", { name: "Memory" }));
  fireEvent.click(within(dialog).getByRole("switch", { name: "Pull requests" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(listed()).toEqual(["Tasks", "Pull requests", "Schedules", "Memory", "More"]);
  expect(JSON.parse(localStorage.getItem("openorc.layout") ?? "{}").hiddenScreens).toEqual(["orchestration"]);
});

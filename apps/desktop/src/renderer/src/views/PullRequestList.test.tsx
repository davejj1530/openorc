import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { useLayout } from "../lib/layout";
import { queryClient } from "../lib/client";
import { PullRequestList } from "./PullRequestList";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/TopBar", () => ({
  TopBar: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <header>
      {children}
      {actions}
    </header>
  ),
}));

const pull = (number: number, title: string) =>
  ({
    number,
    title,
    state: "open",
    isDraft: false,
    reviewDecision: null,
    author: "mara",
    headRefName: `branch-${number}`,
    baseRefName: "main",
    additions: 3,
    deletions: 1,
    updatedAt: 1,
    labels: [],
  }) as unknown as PullRequestSummary;

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useLayout.setState({ workspace: "all" });
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "system.info") return { gh: { installed: true, loggedIn: true } } as never;
    if (method === "projects.list")
      return [
        { id: "studio", name: "studio", gitRemote: "git@github.com:acme/studio.git" },
        { id: "atlas", name: "atlas", gitRemote: "https://github.com/acme/atlas" },
      ] as never;
    if (method === "pulls.list")
      return ((params as { projectId: string }).projectId === "studio" ? [pull(1, "Create the welcome flow"), pull(2, "Polish the picker")] : [pull(3, "Speed up search")]) as never;
    if (method === "pulls.counts") return { open: 3, draft: 1, merged: 2, closed: 0, any: 5 } as never;
    if (method === "pulls.choices") return ((params as { kind: string }).kind === "labels" ? [{ value: "bug", name: "bug", color: "d73a4a" }] : []) as never;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("groups every project's pull requests and folds a group away like a task group", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestList />
    </QueryClientProvider>,
  );
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: /Create the welcome flow/ });
  const heading = within(studio).getByRole("button", { name: /studio/ });
  expect(within(heading).getByLabelText("2 pull requests")).toBeTruthy();
  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(within(studio).queryByRole("button", { name: /Create the welcome flow/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Speed up search/ })).toBeTruthy();
});

const page = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestList />
    </QueryClientProvider>,
  );

const listed = (params: Record<string, unknown>) => expect(vi.mocked(core.call)).toHaveBeenCalledWith("pulls.list", { projectId: "studio", ...params });

it("picks a state from tabs that count every project's pull requests", async () => {
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  const merged = await screen.findByRole("button", { name: "Merged 4" });
  expect(screen.getByRole("button", { name: "Open 6" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(merged);
  await vi.waitFor(() => listed({ state: "merged" }));
  expect(merged.getAttribute("aria-pressed")).toBe("true");
});

it("counts nothing on the tabs while a search is set, since it looks only through the pull requests loaded", async () => {
  sessionStorage.setItem("openorc.pull-list", JSON.stringify({ state: "open", query: "welcome", filters: {}, base: "builtin-all" }));
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  expect(screen.queryByRole("button", { name: /Polish the picker/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Open" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Merged" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove search filter welcome" }));
  await screen.findByRole("button", { name: "Open 6" });
});

it("keeps the views another window saved, and lists them once it says so", async () => {
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  // Another window saves Mara's after this one read the views.
  localStorage.setItem("openorc.pull-views", JSON.stringify([{ id: "maras", name: "Mara's", state: "open", query: "", filters: { authors: ["mara"] } }]));
  fireEvent.click(screen.getByRole("button", { name: "Sort: newest" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save as view…" }));
  fireEvent.change(await screen.findByRole("textbox", { name: /^Name/ }), { target: { value: "Oldest first" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "View: Oldest first" });
  const stored = () => JSON.parse(localStorage.getItem("openorc.pull-views")!) as { id: string; name: string }[];
  expect(stored().map((view) => view.name)).toEqual(["Mara's", "Oldest first"]);

  // Another window deletes Mara's and makes Oldest first the default.
  const oldest = stored().filter((view) => view.name === "Oldest first");
  localStorage.setItem("openorc.pull-views", JSON.stringify(oldest));
  localStorage.setItem("openorc.pull-default-view", oldest[0]!.id);
  window.dispatchEvent(new StorageEvent("storage", { key: "openorc.pull-default-view" }));
  fireEvent.click(await screen.findByRole("button", { name: "View: Oldest first, default" }));
  await screen.findByRole("menuitemradio", { name: /Oldest first/ });
  expect(screen.queryByRole("menuitemradio", { name: /Mara's/ })).toBeNull();
});

it("opens the palette with /, adds what is picked as a token, and takes it off again", async () => {
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  fireEvent.keyDown(window, { key: "/" });
  const input = await screen.findByRole("combobox", { name: /Filter by person/ });
  fireEvent.change(input, { target: { value: "mara" } });
  fireEvent.click(await screen.findByRole("option", { name: "Author mara" }));
  await vi.waitFor(() => listed({ state: "open", authors: ["mara"] }));
  expect(JSON.parse(localStorage.getItem("openorc.pull-filters")!)).toEqual({ authors: ["mara"] });

  // Backspace in the empty field takes the last filter off.
  fireEvent.keyDown(input, { key: "Backspace" });
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Remove author filter mara" })).toBeNull());
  fireEvent.change(input, { target: { value: "bug" } });
  fireEvent.click(await screen.findByRole("option", { name: "Label bug" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove label filter bug" }));
  await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("openorc.pull-filters")!)).toEqual({}));
});

it("marks a view edited when its filters change, and saves, reverts and defaults views from the title", async () => {
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  fireEvent.click(screen.getByRole("button", { name: "Sort: newest" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Most rockets" }));
  await vi.waitFor(() => listed({ state: "open", sort: "reactions_rocket" }));
  expect(screen.getByRole("button", { name: "View: All pull requests, edited" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Save as view…" }));
  fireEvent.change(await screen.findByRole("textbox", { name: /^Name/ }), { target: { value: "Rockets" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const title = await screen.findByRole("button", { name: "View: Rockets, default" });
  expect(localStorage.getItem("openorc.pull-default-view")).toBeTruthy();

  // The built-in views stand in for the old tabs; picking one leaves Rockets behind.
  fireEvent.click(title);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Needs my review" }));
  await vi.waitFor(() => listed({ state: "open", review: "awaiting_you_or_team" }));
  fireEvent.click(screen.getByRole("button", { name: "View: Needs my review" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Rockets/ }));
  await screen.findByRole("button", { name: "View: Rockets, default" });

  // Changing a saved view offers to put it back.
  fireEvent.click(screen.getByRole("button", { name: "Sort: Most rockets" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
  await screen.findByRole("button", { name: "Sort: Most rockets" });
});

it("opens with the default view when the app starts, and as it was left when coming back to it", async () => {
  localStorage.setItem("openorc.pull-views", JSON.stringify([{ id: "maras", name: "Mara's", state: "any", query: "", filters: { authors: ["mara"] } }]));
  localStorage.setItem("openorc.pull-default-view", "maras");
  const first = page();
  await vi.waitFor(() => listed({ state: "any", authors: ["mara"] }));
  expect(screen.getByRole("button", { name: "View: Mara's, default" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove author filter mara" }));
  first.unmount();
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  // With its one filter gone the list is every pull request, still in the state Mara's opened in.
  expect(screen.getByRole("button", { name: "View: All pull requests" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "Remove author filter mara" })).toBeNull();
});

it("edits the view its filters match, even one it wasn't opened as", async () => {
  localStorage.setItem("openorc.pull-views", JSON.stringify([{ id: "maras", name: "Mara's", state: "open", query: "", filters: { authors: ["mara"] } }]));
  sessionStorage.setItem("openorc.pull-list", JSON.stringify({ state: "open", query: "", filters: { authors: ["mara"] }, base: "builtin-all" }));
  page();
  await screen.findByRole("button", { name: "View: Mara's" });
  fireEvent.click(screen.getByRole("button", { name: "Sort: newest" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest" }));
  await screen.findByRole("button", { name: "View: Mara's, edited" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "View: Mara's" });
  expect(JSON.parse(localStorage.getItem("openorc.pull-views")!)[0].filters).toEqual({ authors: ["mara"], sort: "oldest" });
});

it("replaces a view saved under a name already in use, and deleting the default view stops opening with it", async () => {
  localStorage.setItem("openorc.pull-views", JSON.stringify([{ id: "maras", name: "Mara's", state: "open", query: "", filters: { authors: ["mara"] } }]));
  localStorage.setItem("openorc.pull-default-view", "maras");
  page();
  await screen.findByRole("button", { name: "View: Mara's, default" });
  fireEvent.click(screen.getByRole("button", { name: "Sort: newest" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest" }));
  fireEvent.click(await screen.findByRole("button", { name: "View: Mara's, default, edited" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save as a new view…" }));
  fireEvent.change(await screen.findByRole("textbox", { name: /^Name/ }), { target: { value: "mara's" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  // The same view under the name as typed now, still the default.
  const title = await screen.findByRole("button", { name: "View: mara's, default" });
  expect(JSON.parse(localStorage.getItem("openorc.pull-views")!)).toEqual([{ id: "maras", name: "mara's", state: "open", query: "", filters: { authors: ["mara"], sort: "oldest" } }]);

  fireEvent.click(title);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete “mara's”" }));
  await screen.findByRole("button", { name: "View: All pull requests" });
  expect(localStorage.getItem("openorc.pull-default-view")).toBeNull();
  expect(JSON.parse(localStorage.getItem("openorc.pull-views")!)).toEqual([]);
});

it("says a tab is empty when only its order differs, since an order filters nothing out", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "pulls.list" ? ([] as never) : answer(method, params)));
  sessionStorage.setItem("openorc.pull-list", JSON.stringify({ state: "draft", query: "", filters: { sort: "oldest" }, base: "builtin-all" }));
  page();
  await screen.findByText("No drafts");
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

it("opens with every pull request after it stops opening with a view, rather than the view's filters left behind", async () => {
  localStorage.setItem("openorc.pull-views", JSON.stringify([{ id: "maras", name: "Mara's", state: "open", query: "", filters: { authors: ["mara"] } }]));
  localStorage.setItem("openorc.pull-default-view", "maras");
  localStorage.setItem("openorc.pull-filters", JSON.stringify({ authors: ["mara"] }));
  const first = page();
  fireEvent.click(await screen.findByRole("button", { name: "View: Mara's, default" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Stop opening with “Mara's”" }));
  await screen.findByRole("button", { name: "View: Mara's" });
  first.unmount();
  // The app starts again: nothing of this window's list is left.
  sessionStorage.clear();
  page();
  await screen.findByRole("button", { name: "View: All pull requests" });
  expect(screen.queryByRole("button", { name: "Remove author filter mara" })).toBeNull();
});

it("offers to clear the filters when nothing matches them, and then says the tab is empty", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "pulls.list" ? ([] as never) : answer(method, params)));
  sessionStorage.setItem("openorc.pull-list", JSON.stringify({ state: "open", query: "", filters: { labels: ["bug"] }, base: "builtin-all" }));
  page();
  await screen.findByText("No matching pull requests");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByText("No open pull requests");
  listed({ state: "open" });
  expect(screen.queryByRole("button", { name: "Remove label filter bug" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("openorc.pull-filters")!)).toEqual({});
});

it("shows more of a palette group from its last row, keeping what was typed", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  const labels = Array.from({ length: 12 }, (_, index) => ({ value: `area-${index + 10}`, name: `area-${index + 10}`, color: "0e8a16" }));
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "pulls.choices" && (params as { kind: string }).kind === "labels" ? (labels as never) : answer(method, params)));
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  fireEvent.click(screen.getByRole("combobox", { name: "Filter pull requests" }));
  // Reviews has eight rows and opens with five.
  fireEvent.click(await screen.findByRole("option", { name: "Show 3 more reviews" }));
  await screen.findByRole("option", { name: "Review Awaiting review from you or your team" });
  expect(screen.queryByRole("option", { name: /more reviews/ })).toBeNull();

  const input = screen.getByRole("combobox", { name: /Filter by person/ });
  fireEvent.change(input, { target: { value: "area" } });
  fireEvent.click(await screen.findByRole("option", { name: "Show 4 more labels" }));
  await screen.findByRole("option", { name: "Label area-21" });
  expect((input as HTMLInputElement).value).toBe("area");
  expect(vi.mocked(core.call)).not.toHaveBeenCalledWith("pulls.list", expect.objectContaining({ labels: expect.anything() }));
});

it("leaves the palette shut on / while gh is missing, since a disabled palette can't be dismissed", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "system.info" ? ({ gh: { installed: false, loggedIn: false } } as never) : answer(method, params)));
  page();
  await screen.findByText("GitHub CLI not found");
  fireEvent.keyDown(window, { key: "/" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("combobox", { name: /Filter by person/ })).toBeNull();
});

it("folds a palette group away to its header and a count, and remembers it", async () => {
  page();
  await screen.findByRole("button", { name: /Create the welcome flow/ });
  fireEvent.click(screen.getByRole("combobox", { name: "Filter pull requests" }));
  await screen.findByRole("option", { name: "Label bug" });
  fireEvent.click(screen.getByRole("button", { name: "Labels" }));
  await vi.waitFor(() => expect(screen.queryByRole("option", { name: "Label bug" })).toBeNull());
  // bug, and the row for pull requests with no label.
  const folded = screen.getByRole("button", { name: "Labels, 2 folded away" });
  expect(folded.getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(localStorage.getItem("openorc.pull-palette-folded")!)).toEqual(["Labels"]);
  fireEvent.click(folded);
  await screen.findByRole("option", { name: "Label bug" });
});

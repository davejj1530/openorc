// @vitest-environment jsdom
import type { BoardTask } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { copied } from "../test-fixtures/clipboard";
import { reduceMotion } from "../test-fixtures/react-native";
import type { BoardSection } from "./board";
import { TaskList } from "./TaskList";

const pushed = vi.hoisted(() => [] as unknown[]);
const listed = vi.hoisted(() => ({ sections: [] as BoardSection[] }));
vi.mock("expo-router", () => ({
  Link: Object.assign(({ children, href }: { children: ReactNode; href: unknown }) => <div data-href={JSON.stringify(href)}>{children}</div>, {
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Menu: ({ title, children }: { title: string; children: ReactNode }) => <div aria-label={`Menu for ${title}`}>{children}</div>,
    MenuAction: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <button role="menuitem" onClick={onPress}>
        {children}
      </button>
    ),
  }),
  router: { push: (route: unknown) => void pushed.push(route) },
}));
vi.mock("./use-task-board", () => ({ useTaskBoard: () => ({ sections: listed.sections, available: true }) }));
const scopes = vi.hoisted(() => [] as (string | null)[]);
vi.mock("../connection/HostScope", async () => {
  const { useEffect } = await import("react");
  return {
    HostScope: ({ host, children }: { host: string | null; children: ReactNode }) => {
      // Once per mount: a scope that stays mounted keeps the client it started on.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => void scopes.push(host), []);
      return <>{children}</>;
    },
  };
});
vi.mock("../client", () => ({ useRpc: () => ({ data: [{ id: "p", name: "Website" }] }) }));

afterEach(() => {
  cleanup();
  pushed.length = 0;
  copied.length = 0;
  reduceMotion.set(false);
  vi.useRealTimers();
});

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  projectId: "p",
  title: id,
  status: "backlog",
  priority: "none",
  threadId: null,
  executionThreadId: null,
  updatedAt: minutesAgo(5),
  ...extra,
});
const mac = (tasks: BoardTask[]): BoardSection => ({ key: "mac", title: "Studio", host: null, namesOn: null, tasks, copy: null });

it("groups a host's tasks by status in the desktop's order, saying each row's status, priority, project and age", () => {
  listed.sections = [
    mac([
      task("Write docs"),
      task("Fix login", { status: "in_progress", priority: "urgent", updatedAt: minutesAgo(2) }),
      task("Ship the badge", { status: "review", priority: "high" }),
      task("Try a cache", { status: "proposed" }),
      task("Add search", { status: "in_progress", priority: "low", updatedAt: minutesAgo(120) }),
    ]),
  ];
  render(<TaskList top={0} bottom={0} />);
  const headings = screen.getAllByRole("button", { expanded: true }).map((heading) => heading.getAttribute("aria-label"));
  expect(headings).toEqual(["In progress, 2", "Ready for review, 1", "Proposed, 1", "Backlog, 1"]);
  expect(screen.getByRole("button", { name: "Fix login, In progress, Urgent, Website, 2m ago" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add search, In progress, Low priority, Website, 2h ago" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Write docs, Backlog, Website, 5m ago" })).toBeTruthy();
  // One host is not named: the list is its tasks.
  expect(screen.queryByRole("header")).toBeNull();
});

it("folds a group under its heading, its rows fading first, and opens it again", () => {
  vi.useFakeTimers();
  listed.sections = [mac([task("Fix login", { status: "in_progress" }), task("Write docs")])];
  render(<TaskList top={0} bottom={0} />);
  const heading = screen.getByRole("button", { name: "In progress, 1" });
  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: /^Fix login/ })).toBeTruthy();
  act(() => void vi.advanceTimersByTime(200));
  expect(screen.queryByRole("button", { name: /^Fix login/ })).toBeNull();
  expect(screen.getByRole("button", { name: /^Write docs/ })).toBeTruthy();
  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^Fix login/ })).toBeTruthy();
});

it("keeps a closing group open when its heading is tapped again before it folds, and folds at once under reduced motion", () => {
  vi.useFakeTimers();
  listed.sections = [mac([task("Fix login", { status: "in_progress" }), task("Write docs")])];
  render(<TaskList top={0} bottom={0} />);
  const working = screen.getByRole("button", { name: "In progress, 1" });
  fireEvent.click(working);
  fireEvent.click(working);
  act(() => void vi.advanceTimersByTime(1000));
  expect(working.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^Fix login/ })).toBeTruthy();
  act(() => reduceMotion.set(true));
  fireEvent.click(screen.getByRole("button", { name: "Backlog, 1" }));
  expect(screen.queryByRole("button", { name: /^Write docs/ })).toBeNull();
});

it("offers a task's thread and its title from the row's menu", () => {
  listed.sections = [mac([task("Fix login", { executionThreadId: "work", threadId: "origin" }), task("Write docs")])];
  render(<TaskList top={0} bottom={0} />);
  const menu = screen.getByLabelText("Menu for Fix login");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open Thread" }));
  expect(pushed).toEqual([{ pathname: "/thread/[id]", params: { id: "work" } }]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy Title" }));
  expect(copied).toEqual(["Fix login"]);
  expect(within(screen.getByLabelText("Menu for Write docs")).queryByRole("menuitem", { name: "Open Thread" })).toBeNull();
});

it("says the Mac is needed when a task from its copied list is pressed, and opens a cloud task on the brain, with or without a conversation", () => {
  listed.sections = [
    { key: "mac-copy", title: "Studio", host: null, namesOn: "brain", tasks: [task("Write docs", { threadId: "mac-thread" })], copy: { at: minutesAgo(5), cloudOnly: true } },
    { key: "brain:brain", title: "Cloud", host: "brain", namesOn: "brain", tasks: [task("Fix login", { executionThreadId: "cloud-thread" }), task("Later")], copy: null },
  ];
  render(<TaskList top={0} bottom={0} />);
  expect(screen.getByRole("header", { name: "Studio, As of 5m ago" })).toBeTruthy();
  expect(screen.getByRole("header", { name: "Cloud" })).toBeTruthy();
  expect(screen.getByText("Only projects in the cloud")).toBeTruthy();
  const copiedRow = screen.getByRole("button", { name: "Write docs, Backlog, Website, 5m ago" });
  expect(copiedRow.closest("[data-href]")).toBeNull();
  expect(screen.queryByLabelText("Menu for Write docs")).toBeNull();
  expect(screen.queryByText("This task is on your Mac, which is asleep.")).toBeNull();
  fireEvent.click(copiedRow);
  expect(screen.getByText("This task is on your Mac, which is asleep.")).toBeTruthy();
  const href = (row: HTMLElement) => JSON.parse(row.closest("[data-href]")!.getAttribute("data-href")!) as unknown;
  expect(href(screen.getByRole("button", { name: "Fix login, Backlog, Website, 5m ago" }))).toEqual({ pathname: "/task/[id]", params: { id: "Fix login", host: "brain", thread: "cloud-thread" } });
  expect(href(screen.getByRole("button", { name: "Later, Backlog, Website, 5m ago" }))).toEqual({ pathname: "/task/[id]", params: { id: "Later", host: "brain" } });
});

it("names no missing projects under the Mac's list the phone heard itself", () => {
  listed.sections = [{ key: "mac-copy", title: "Studio", host: null, namesOn: null, tasks: [task("Write docs")], copy: { at: minutesAgo(60), cloudOnly: false } }];
  render(<TaskList top={0} bottom={0} />);
  expect(screen.getByRole("header", { name: "Studio, As of 1h ago" })).toBeTruthy();
  expect(screen.queryByText("Only projects in the cloud")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Write docs/ }));
  expect(screen.getByText("This task is on your Mac, which is asleep.")).toBeTruthy();
});

it("names a copy's projects on the host it came from, also when the newest copy moves from the phone's to the brain's", () => {
  const copy = (namesOn: string | null): BoardSection => ({
    key: "mac-copy",
    title: "Studio",
    host: null,
    namesOn,
    tasks: [task("Write docs")],
    copy: { at: Date.now(), cloudOnly: namesOn !== null },
  });
  listed.sections = [copy(null)];
  const view = render(<TaskList top={0} bottom={0} />);
  listed.sections = [copy("brain")];
  view.rerender(<TaskList top={0} bottom={0} />);
  expect(scopes.slice(-2)).toEqual([null, "brain"]);
});

it("says there are no open tasks when no host lists any", () => {
  listed.sections = [mac([])];
  render(<TaskList top={0} bottom={0} />);
  expect(screen.getByText("No open tasks")).toBeTruthy();
});

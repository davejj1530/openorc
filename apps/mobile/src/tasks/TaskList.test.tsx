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
const listed = vi.hoisted(() => ({ section: null as BoardSection | null }));
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
vi.mock("./use-task-board", () => ({ useTaskBoard: () => ({ section: listed.section, available: true }) }));
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
const mac = (tasks: BoardTask[]): BoardSection => ({ key: "mac", title: "Studio", tasks, copiedAt: null });

it("groups the Mac's tasks by status in the desktop's order, saying each row's status, priority, project and age", () => {
  listed.section = mac([
    task("Write docs"),
    task("Fix login", { status: "in_progress", priority: "urgent", updatedAt: minutesAgo(2) }),
    task("Ship the badge", { status: "review", priority: "high" }),
    task("Try a cache", { status: "proposed" }),
    task("Add search", { status: "in_progress", priority: "low", updatedAt: minutesAgo(120) }),
  ]);
  render(<TaskList top={0} bottom={0} />);
  const headings = screen.getAllByRole("button", { expanded: true }).map((heading) => heading.getAttribute("aria-label"));
  expect(headings).toEqual(["In progress, 2", "Ready for review, 1", "Proposed, 1", "Backlog, 1"]);
  expect(screen.getByRole("button", { name: "Fix login, In progress, Urgent, Website, 2m ago" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add search, In progress, Low priority, Website, 2h ago" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Write docs, Backlog, Website, 5m ago" })).toBeTruthy();
  // A live Mac is not named: the list is its tasks.
  expect(screen.queryByRole("header")).toBeNull();
});

it("folds a group under its heading, its rows fading first, and opens it again", () => {
  vi.useFakeTimers();
  listed.section = mac([task("Fix login", { status: "in_progress" }), task("Write docs")]);
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
  listed.section = mac([task("Fix login", { status: "in_progress" }), task("Write docs")]);
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
  listed.section = mac([task("Fix login", { executionThreadId: "work", threadId: "origin" }), task("Write docs")]);
  render(<TaskList top={0} bottom={0} />);
  const menu = screen.getByLabelText("Menu for Fix login");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open Thread" }));
  expect(pushed).toEqual([{ pathname: "/thread/[id]", params: { id: "work" } }]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy Title" }));
  expect(copied).toEqual(["Fix login"]);
  expect(within(screen.getByLabelText("Menu for Write docs")).queryByRole("menuitem", { name: "Open Thread" })).toBeNull();
});

it("says the Mac is needed when a task from its last list is pressed, and opens a live task with or without a conversation", () => {
  listed.section = { key: "mac-copy", title: "Studio", tasks: [task("Write docs", { threadId: "mac-thread" })], copiedAt: minutesAgo(60) };
  const view = render(<TaskList top={0} bottom={0} />);
  expect(screen.getByRole("header", { name: "Studio, As of 1h ago" })).toBeTruthy();
  const copiedRow = screen.getByRole("button", { name: "Write docs, Backlog, Website, 5m ago" });
  expect(copiedRow.closest("[data-href]")).toBeNull();
  expect(screen.queryByLabelText("Menu for Write docs")).toBeNull();
  expect(screen.queryByText("This task is on your Mac, which is asleep.")).toBeNull();
  fireEvent.click(copiedRow);
  expect(screen.getByText("This task is on your Mac, which is asleep.")).toBeTruthy();
  listed.section = mac([task("Fix login", { executionThreadId: "work-thread" }), task("Later")]);
  view.rerender(<TaskList top={0} bottom={0} />);
  expect(screen.queryByRole("header")).toBeNull();
  const href = (row: HTMLElement) => JSON.parse(row.closest("[data-href]")!.getAttribute("data-href")!) as unknown;
  expect(href(screen.getByRole("button", { name: "Fix login, Backlog, Website, 5m ago" }))).toEqual({ pathname: "/task/[id]", params: { id: "Fix login", thread: "work-thread" } });
  expect(href(screen.getByRole("button", { name: "Later, Backlog, Website, 5m ago" }))).toEqual({ pathname: "/task/[id]", params: { id: "Later" } });
});

it("says there are no open tasks when the Mac lists none", () => {
  listed.section = mac([]);
  render(<TaskList top={0} bottom={0} />);
  expect(screen.getByText("No open tasks")).toBeTruthy();
});

// @vitest-environment jsdom
import type { BoardTask } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardSection } from "./board";
import { TasksScreen } from "./TasksScreen";

const listed = vi.hoisted(() => ({ sections: [] as BoardSection[] }));
vi.mock("expo-router", () => ({
  Link: ({ children, href }: { children: ReactNode; href: unknown }) => <div data-href={JSON.stringify(href)}>{children}</div>,
  Stack: { Screen: () => null },
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

afterEach(cleanup);

const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  projectId: "p",
  title: id,
  status: "backlog",
  priority: "none",
  threadId: null,
  executionThreadId: null,
  updatedAt: 1,
  ...extra,
});

it("says the Mac is needed when a task from its copied list is pressed, and opens a cloud task's conversation on the brain", () => {
  listed.sections = [
    { key: "mac-copy", title: "Studio", host: null, namesOn: "brain", tasks: [task("Write docs", { threadId: "mac-thread" })], copy: { at: Date.now() - 5 * 60_000, cloudOnly: true } },
    { key: "brain:brain", title: "Cloud", host: "brain", namesOn: "brain", tasks: [task("Fix login", { executionThreadId: "cloud-thread" }), task("Later")], copy: null },
  ];
  render(<TasksScreen />);
  expect(screen.getByRole("header", { name: "Studio, As of 5m ago" })).toBeTruthy();
  expect(screen.getByText("Only projects in the cloud")).toBeTruthy();
  const copied = screen.getByRole("button", { name: "Write docs, Backlog, Website" });
  expect(copied.closest("[data-href]")).toBeNull();
  expect(screen.queryByText("This task is on your Mac, which is asleep.")).toBeNull();
  fireEvent.click(copied);
  expect(screen.getByText("This task is on your Mac, which is asleep.")).toBeTruthy();
  const cloud = screen.getByRole("button", { name: "Fix login, Backlog, Website" });
  expect(JSON.parse(cloud.closest("[data-href]")!.getAttribute("data-href")!)).toEqual({ pathname: "/thread/[id]", params: { id: "cloud-thread", host: "brain" } });
  expect(screen.queryByRole("button", { name: "Later, Backlog, Website" })).toBeNull();
});

it("names no missing projects under the Mac's list the phone heard itself", () => {
  listed.sections = [{ key: "mac-copy", title: "Studio", host: null, namesOn: null, tasks: [task("Write docs")], copy: { at: Date.now() - 60 * 60_000, cloudOnly: false } }];
  render(<TasksScreen />);
  expect(screen.getByRole("header", { name: "Studio, As of 1h ago" })).toBeTruthy();
  expect(screen.queryByText("Only projects in the cloud")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Write docs, Backlog, Website" }));
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
  const view = render(<TasksScreen />);
  listed.sections = [copy("brain")];
  view.rerender(<TasksScreen />);
  expect(scopes.slice(-2)).toEqual([null, "brain"]);
});

it("says there are no open tasks when no host lists any", () => {
  listed.sections = [{ key: "mac", title: "Studio", host: null, namesOn: null, tasks: [], copy: null }];
  render(<TasksScreen />);
  expect(screen.getByText("No open tasks")).toBeTruthy();
});

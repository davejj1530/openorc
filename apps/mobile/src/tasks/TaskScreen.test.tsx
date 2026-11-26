// @vitest-environment jsdom
import type { Task } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { alerts, nativeProps } from "../test-fixtures/react-native";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  task: null as unknown as Task,
  saved: [] as unknown[],
  refuse: null as string | null,
  /** What the Mac was asked to do with the task's work, and the Refine it holds. */
  work: [] as unknown[],
  refine: null as unknown,
  buttons: [] as unknown[],
  threads: [] as unknown[],
  /** The project's board columns, and every method the phone asked for. */
  columns: [] as unknown[],
  asked: [] as string[],
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    mac.asked.push(method);
    if (method === "tasks.get") return mac.task;
    if (method === "board.columns") return mac.columns;
    if (method === "projects.list") return [{ id: "p", name: "Website", settings: { taskButtons: mac.buttons } }];
    if (method === "tasks.threads") return mac.threads;
    if (method === "tasks.refine.get") return mac.refine;
    if (method === "tasks.runButton" || method === "tasks.refine.dismiss") {
      mac.work.push([method, params]);
      if (method === "tasks.refine.dismiss") mac.refine = null;
      return method === "tasks.runButton" ? { threadId: "t-review", message: "Review the task", draft: "Review the task" } : null;
    }
    if (method === "agents.models" || method === "orclings.chats") return [];
    if (method === "threads.get") return { id: (params as { id: string }).id, title: "Fix the login form" };
    if (method === "tasks.update") {
      const { patch } = params as { patch: Partial<Task> };
      mac.saved.push(patch);
      if (mac.refuse) throw new Error(mac.refuse);
      mac.task = { ...mac.task, ...patch };
      return mac.task;
    }
    throw new Error(`no ${method}`);
  });
  return mac.phone.module;
});
const params = vi.hoisted(() => ({ id: "task-1" }));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => params };
});
vi.mock("../thread/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: <T,>(select: (state: { isVisible: boolean; height: number }) => T) => select({ isVisible: false, height: 0 }) }));

const { TaskScreen } = await import("./TaskScreen");
const { TaskDescriptionSheet } = await import("./TaskDescriptionSheet");

const base: Task = {
  id: "task-1",
  projectId: "p",
  title: "Ship the badge",
  spec: "Show a badge on new threads.",
  status: "backlog",
  priority: "none",
  labels: ["ui"],
  workspaceMode: "worktree",
  baseRef: null,
  baseSha: null,
  branch: null,
  worktreePath: null,
  parentTaskId: null,
  threadId: null,
  executionThreadId: null,
  origin: "user",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: 1,
  updatedAt: Date.now(),
  completedAt: null,
};

beforeEach(() => {
  mac.task = { ...base };
  mac.saved = [];
  mac.refuse = null;
  mac.work = [];
  mac.refine = null;
  mac.buttons = [];
  mac.threads = [];
  mac.columns = [];
  mac.asked = [];
  mac.phone!.shared.clear();
  mac.phone!.saved.clear();
  alerts.length = 0;
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.push).mockClear();
  vi.mocked(router.back).mockClear();
});
afterEach(cleanup);

const native = <T,>(element: HTMLElement, prop: string) => nativeProps.get(element)![prop] as T;

it("changes the status and priority from their menus, showing each at once", async () => {
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Status, Backlog" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "In progress" }));
  expect(await screen.findByRole("button", { name: "Status, In progress" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Priority, No priority" }));
  // The stand-in's menus stay open after a choice; the newest is the priority's.
  fireEvent.click(within(screen.getAllByRole("menu").at(-1)!).getByRole("menuitemradio", { name: "Urgent" }));
  await waitFor(() => expect(mac.saved).toEqual([{ status: "in_progress" }, { priority: "urgent" }]));
  expect(screen.getByRole("button", { name: "Priority, Urgent" })).toBeTruthy();
});

it("renames the task when its title loses focus, as one line, and keeps an empty title from saving", async () => {
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  const title = await screen.findByLabelText("Task title");
  act(() => native<() => void>(title, "onFocus")());
  act(() => native<(text: string) => void>(title, "onChangeText")("Ship the new\nbadge"));
  act(() => native<() => void>(title, "onBlur")());
  await waitFor(() => expect(mac.saved).toEqual([{ title: "Ship the newbadge" }]));
  act(() => native<() => void>(title, "onFocus")());
  act(() => native<(text: string) => void>(title, "onChangeText")("   "));
  act(() => native<() => void>(title, "onBlur")());
  expect(mac.saved).toHaveLength(1);
  expect(native<string>(title, "value")).toBe("Ship the newbadge");
});

it("edits the labels as one comma separated prompt", async () => {
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Edit labels" }));
  expect(alerts[0]).toMatchObject({ title: "Labels", defaultValue: "ui" });
  act(() => alerts[0]!.buttons!.find((button) => button.text === "Save")!.onPress!("ui, phone, , ui"));
  await waitFor(() => expect(mac.saved).toEqual([{ labels: ["ui", "phone"] }]));
});

it("puts a change the Mac refuses back, and says why", async () => {
  mac.refuse = "Update OpenOrc on your Mac to edit its tasks here.";
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Status, Backlog" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Done" }));
  await waitFor(() => expect(alerts).toEqual([expect.objectContaining({ title: "Couldn’t save the task", message: mac.refuse })]));
  expect(screen.getByRole("button", { name: "Status, Backlog" })).toBeTruthy();
});

const boardColumn = (id: string, name: string, stage: string) => ({ id, projectId: "p", name, stage, job: null, nextColumnId: null, jobEnabled: true });
const BOARD = [
  boardColumn("col-plan", "Plan", "backlog"),
  boardColumn("col-build", "Build", "in_progress"),
  boardColumn("col-review", "Code review", "review"),
  boardColumn("col-done", "Done", "done"),
];
const menuChoices = () =>
  within(screen.getAllByRole("menu").at(-1)!)
    .getAllByRole("menuitemradio")
    .map((item) => item.textContent);

it("names the board's columns in the Status menu, the task in the first column of its status, and puts it in the one picked", async () => {
  mac.phone!.shared.add("board-columns");
  mac.columns = BOARD;
  mac.task = { ...base, status: "in_progress" };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Status, Build" }));
  expect(menuChoices()).toEqual(["Proposed", "Plan", "Build", "Code review", "Done", "Archived"]);
  fireEvent.click(within(screen.getAllByRole("menu").at(-1)!).getByRole("menuitemradio", { name: "Code review" }));
  expect(await screen.findByRole("button", { name: "Status, Code review" })).toBeTruthy();
  await waitFor(() => expect(mac.saved).toEqual([{ columnId: "col-review" }]));
  // A status no column stands for is saved as the status. The stand-in's menu stays open after a choice.
  fireEvent.click(within(screen.getAllByRole("menu").at(-1)!).getByRole("menuitemradio", { name: "Archived" }));
  await waitFor(() => expect(mac.saved).toEqual([{ columnId: "col-review" }, { status: "archived" }]));
});

it("shows a task in the column it was put in, when its stage has more than one", async () => {
  mac.phone!.shared.add("board-columns");
  mac.columns = [...BOARD.slice(0, 2), boardColumn("col-polish", "Polish", "in_progress"), ...BOARD.slice(2)];
  mac.task = { ...base, status: "in_progress", columnId: "col-polish" };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByRole("button", { name: "Status, Polish" })).toBeTruthy();
});

it("keeps the statuses for a Mac from before board columns, and never asks it for any", async () => {
  mac.columns = BOARD;
  mac.task = { ...base, status: "in_progress" };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Status, In progress" }));
  expect(menuChoices()).toEqual(["Proposed", "Backlog", "In progress", "Review", "Done", "Archived"]);
  expect(mac.asked).not.toContain("board.columns");
});

it("says plainly that the Mac can't be reached when a move never got to it, so no automation starts", async () => {
  mac.refuse = "Your Mac did not answer in time.";
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Status, Backlog" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "In progress" }));
  await waitFor(() => expect(alerts).toEqual([{ title: "Your Mac can’t be reached", message: "The task did not move, so no automation will start." }]));
  expect(screen.getByRole("button", { name: "Status, Backlog" })).toBeTruthy();
  // Any other change keeps the Mac's own words.
  fireEvent.click(screen.getByRole("button", { name: "Priority, No priority" }));
  fireEvent.click(within(screen.getAllByRole("menu").at(-1)!).getByRole("menuitemradio", { name: "Urgent" }));
  await waitFor(() => expect(alerts.at(-1)).toMatchObject({ title: "Couldn’t save the task", message: "Your Mac did not answer in time." }));
});

it("opens the description to edit, and leaves one that holds a secret to the Mac", async () => {
  const view = render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/task-description", params: { id: "task-1" } });
  view.unmount();
  mac.phone!.module.queryClient.clear();
  mac.task = { ...base, spec: "Use [redacted:github-token] to publish." };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("This description holds a secret, so edit it on your Mac.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
});

it("saves a written description and closes, asking first when the Mac's changed meanwhile", async () => {
  render(<TaskDescriptionSheet />, { wrapper: mac.phone!.wrapper });
  const field = await screen.findByLabelText("Task description");
  act(() => native<(text: string) => void>(field, "onChangeText")("## Goal\nShow a badge."));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(mac.saved).toEqual([{ spec: "## Goal\nShow a badge." }]);
  cleanup();
  mac.saved = [];
  render(<TaskDescriptionSheet />, { wrapper: mac.phone!.wrapper });
  const again = await screen.findByLabelText("Task description");
  act(() => native<(text: string) => void>(again, "onChangeText")("Mine"));
  mac.task = { ...mac.task, spec: "Changed on the Mac" };
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  // The cache tells its readers on the next tick.
  await act(() => new Promise((tick) => setTimeout(tick, 0)));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(alerts.at(-1)).toMatchObject({ title: "This description changed on your Mac" });
  expect(mac.saved).toEqual([]);
  act(() => alerts.at(-1)!.buttons!.find((button) => button.text === "Replace")!.onPress!());
  await waitFor(() => expect(mac.saved).toEqual([{ spec: "Mine" }]));
});

it("lists every thread of the task, runs a button into its thread's draft, and uses a suggestion, where the Mac shares task work", async () => {
  mac.phone!.shared.add("task-work");
  mac.buttons = [
    { id: "review", label: "Review", prompt: "Review the task", runsIn: "new", mode: "thread", autoSend: false },
    { id: "ship", label: "Ship", prompt: "Ship it", runsIn: "task", mode: "thread", statuses: ["review"] },
  ];
  const thread = (id: string, title: string) => ({ id, title, activity: "idle", updatedAt: Date.now(), lastActivityAt: Date.now() });
  mac.threads = [
    { thread: thread("t-now", "Ship the badge"), label: null, current: true },
    { thread: thread("t-old", "First try"), label: null, current: false },
    { thread: thread("t-review", "Review the badge"), label: "Review", current: false },
  ];
  mac.refine = {
    id: "r1",
    taskId: "task-1",
    state: "ready",
    recipient: { agent: "claude", model: "opus", effort: null },
    instruction: "",
    base: { title: base.title, spec: base.spec, labels: base.labels },
    suggestion: { title: "Show a badge on new threads", description: "## Goal\n\nShow a badge on new threads.", labels: ["ui", "home"], note: "Split the goal out." },
    step: null,
    error: null,
    runId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByRole("button", { name: /^Current thread.*, Ship the badge$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Earlier thread.*, First try$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Review.*, Review the badge$/ })).toBeTruthy();
  // A button shows only on the statuses it is set for.
  expect(screen.queryByRole("button", { name: "Ship" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "t-review" } }));
  expect(mac.work).toEqual([["tasks.runButton", { taskId: "task-1", buttonId: "review" }]]);
  expect(JSON.parse(mac.phone!.saved.get("draft.mac-1.t-review")!)).toMatchObject({ text: "Review the task" });

  // The suggestion stands in the description's place until it is used.
  expect(screen.getByText("Suggested by opus")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
  await waitFor(() => expect(mac.saved).toEqual([{ title: "Show a badge on new threads", spec: "## Goal\n\nShow a badge on new threads.", labels: ["ui", "home"] }]));
  await waitFor(() => expect(mac.work.at(-1)).toEqual(["tasks.refine.dismiss", { taskId: "task-1" }]));
  expect(await screen.findByRole("button", { name: "Edit description" })).toBeTruthy();
});

it("shows the conversation doing the work, and neither buttons nor Refine, for a Mac that shares no task work", async () => {
  mac.buttons = [{ id: "review", label: "Review", prompt: "Review the task", runsIn: "new", mode: "thread" }];
  mac.task = { ...base, executionThreadId: "t-now" };
  render(<TaskScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByRole("button", { name: "Working in, Fix the login form" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refine this task" })).toBeNull();
});

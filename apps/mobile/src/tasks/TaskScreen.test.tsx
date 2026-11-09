// @vitest-environment jsdom
import type { Task } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { alerts, nativeProps } from "../test-fixtures/react-native";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, task: null as unknown as Task, saved: [] as unknown[], refuse: null as string | null }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    if (method === "tasks.get") return mac.task;
    if (method === "projects.list") return [{ id: "p", name: "Website" }];
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

// @vitest-environment jsdom
import type { RpcParams } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostContext } from "../connection/host-context";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  shares: true as boolean,
  projects: [] as { id: string; name: string }[],
  git: "ready" as string,
  create: null as unknown as ReturnType<typeof vi.fn<(params: RpcParams<"tasks.create">) => Promise<{ id: string }>>>,
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    if (method === "projects.list") return mac.projects;
    if (method === "projects.git") {
      if (mac.git === "unreadable") throw new Error("git rev-parse failed");
      return mac.git;
    }
    if (method === "app.settings.get") return { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: null };
    if (method === "tasks.create") return mac.create(params as RpcParams<"tasks.create">);
    throw new Error(`no ${method}`);
  });
  Object.assign(mac.phone.module.link.connection, { shares: async () => mac.shares });
  return mac.phone.module;
});
vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("expo-router", () => ({ router: { replace: vi.fn() }, useNavigation: () => ({ isFocused: () => true }) }));

const { NewTaskScreen } = await import("./NewTaskScreen");

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  mac.shares = true;
  mac.git = "ready";
  mac.projects = [
    { id: "site", name: "Website" },
    { id: "app", name: "App" },
  ];
  mac.create = vi.fn();
  vi.mocked(router.replace).mockClear();
});
afterEach(cleanup);

const type = (label: string, text: string) => act(() => (nativeProps.get(screen.getByLabelText(label))!.onChangeText as (text: string) => void)(text));
const create = () => screen.getByRole("button", { name: "Create task" });

it("saves a titled task in the backlog at the chosen priority and project, in a worktree as the Mac does by default, and opens it", async () => {
  render(<NewTaskScreen />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Project, Website" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "App" }));
  fireEvent.click(screen.getByRole("button", { name: "Priority, No priority" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "High priority" }));
  expect(screen.getByLabelText("Status Backlog")).toBeTruthy();
  type("Task title", "Ship the\nbadge");
  type("Task description", "## Goal\nShow a badge.");
  await waitFor(() => expect(create().getAttribute("aria-disabled")).toBe("false"));
  mac.create.mockResolvedValue({ id: "task-9" });
  await act(async () => fireEvent.click(create()));
  expect(mac.create).toHaveBeenCalledWith({ projectId: "app", title: "Ship thebadge", spec: "## Goal\nShow a badge.", priority: "high", useWorktree: true });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: "/task/[id]", params: { id: "task-9" } }));
});

it.each(["no_commits", "unreadable"])("works in the checkout of a project whose git is %s, and opens a task saved on the cloud brain there", async (git) => {
  mac.git = git;
  render(
    <HostContext.Provider value="brain-1">
      <NewTaskScreen />
    </HostContext.Provider>,
    { wrapper: mac.phone!.wrapper },
  );
  await screen.findByRole("button", { name: "Project, Website" });
  type("Task title", "Write the notes");
  await waitFor(() => expect(create().getAttribute("aria-disabled")).toBe("false"));
  mac.create.mockResolvedValue({ id: "task-10" });
  await act(async () => fireEvent.click(create()));
  expect(mac.create).toHaveBeenCalledWith({ projectId: "site", title: "Write the notes", priority: "none", useWorktree: false });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: "/task/[id]", params: { id: "task-10", host: "brain-1" } }));
});

it("keeps what was written and says why when the Mac refuses, and asks for a title before saving", async () => {
  render(<NewTaskScreen />, { wrapper: mac.phone!.wrapper });
  await screen.findByRole("button", { name: "Project, Website" });
  await act(async () => fireEvent.click(create()));
  expect(screen.getByRole("alert").textContent).toBe("Give the task a title.");
  expect(mac.create).not.toHaveBeenCalled();
  type("Task title", "Ship it");
  await waitFor(() => expect(create().getAttribute("aria-disabled")).toBe("false"));
  mac.create.mockRejectedValue(new Error("A title must be one line of up to 200 characters."));
  await act(async () => fireEvent.click(create()));
  expect(screen.getByRole("alert").textContent).toBe("A title must be one line of up to 200 characters.");
  expect(nativeProps.get(screen.getByLabelText("Task title"))!.value).toBe("Ship it");
  expect(router.replace).not.toHaveBeenCalled();
});

it("says an older Mac needs an update, and that a Mac without projects needs one first", async () => {
  mac.shares = false;
  const view = render(<NewTaskScreen />, { wrapper: mac.phone!.wrapper });
  expect(await screen.findByText("Update OpenOrc on your Mac to add tasks from your phone.")).toBeTruthy();
  expect(create().getAttribute("aria-disabled")).toBe("true");
  view.unmount();
  mac.shares = true;
  mac.projects = [];
  mac.phone!.module.queryClient.clear();
  render(<NewTaskScreen />, { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(create().getAttribute("aria-disabled")).toBe("true"));
  await act(async () => fireEvent.click(create()));
  expect(screen.getByRole("alert").textContent).toBe("Add a project on your Mac to save tasks in it.");
});

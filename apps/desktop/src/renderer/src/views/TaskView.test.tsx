import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRouter, type TaskTab } from "../lib/router";
import { TaskView } from "./TaskView";

const mocks = vi.hoisted(() => ({ call: vi.fn(), changes: vi.fn(), commits: vi.fn(), panel: vi.fn(), flush: vi.fn(), setPanel: vi.fn(), followProject: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onReady: () => {}, onPush: () => () => {} } }));
vi.mock("../lib/layout", () => ({ useLayout: (select: (state: unknown) => unknown) => select({ setPanel: mocks.setPanel, followProject: mocks.followProject }) }));
vi.mock("../components/Panel", () => ({
  Panel: (props: unknown) => {
    mocks.panel(props);
    return null;
  },
}));
vi.mock("../panels/ChangesPanel", () => ({
  ChangesPanel: (props: unknown) => {
    mocks.changes(props);
    return <div>Execution changes</div>;
  },
}));
vi.mock("../panels/CommitsPanel", () => ({
  CommitsPanel: (props: unknown) => {
    mocks.commits(props);
    return <div>Execution commits</div>;
  },
}));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../components/TaskActivity", () => ({ TaskActivity: () => <div>Saved activity</div> }));
vi.mock("./TaskDocument", () => ({
  TaskDocument: ({ ref }: { ref: Ref<{ flush: () => Promise<boolean> }> }) => {
    useImperativeHandle(ref, () => ({ flush: mocks.flush }));
    return <div>Task document</div>;
  },
}));
beforeEach(() => {
  mocks.flush.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(owner: { id: string; teamInstanceId: string | null } | null, tab: TaskTab = "files", retainedTeam = false, cachedMemory = true) {
  const task = { id: "task", projectId: "project", title: "Task B", status: "backlog", threadId: "creator", executionThreadId: owner?.id ?? null, baseSha: "viewed-diff", retiredTeam: retainedTeam };
  const project = { id: "project", name: "Project" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["tasks.get", { id: task.id }], task);
  client.setQueryData(["projects.get", { id: project.id }], project);
  client.setQueryData(["tasks.executionThread", { taskId: task.id }], owner);
  if (cachedMemory) client.setQueryData(["memory.forTask", { taskId: task.id }], { memories: [], summaries: [] });
  client.setQueryData(["memory.settings.get", {}], { enabled: false });
  useRouter.setState({ route: { view: "task", taskId: task.id, tab } });
  render(
    <QueryClientProvider client={client}>
      <TaskView taskId={task.id} tab={tab} />
    </QueryClientProvider>,
  );
  return { task, project };
}

it("shows pending execution without opening the creator's diff or assigning a conversation", () => {
  show(null);
  expect(screen.getByText("No execution yet")).toBeTruthy();
  expect(mocks.changes).not.toHaveBeenCalled();
  expect(mocks.call).not.toHaveBeenCalled();
});

it.each(["creator", "executor"])("shows Changes for the assigned %s conversation without activity underneath", (id) => {
  const owner = { id, teamInstanceId: null };
  const { task, project } = show(owner);
  expect(mocks.changes).toHaveBeenCalledWith({ thread: owner, project, task });
  expect(screen.getByRole("tabpanel", { name: "Changes" }).textContent).toBe("Execution changes");
  expect(screen.queryByText("Saved activity")).toBeNull();
  expect(mocks.call).not.toHaveBeenCalled();
});

it("hides an old task even when a cached query still contains it", () => {
  show(null, "files", true);
  expect(screen.getByText("Task not found")).toBeTruthy();
  expect(mocks.changes).not.toHaveBeenCalled();
  expect(mocks.call).not.toHaveBeenCalled();
});

it("shows Commits as the page body for the assigned conversation", () => {
  const owner = { id: "executor", teamInstanceId: null };
  const { project } = show(owner, "commits");
  expect(mocks.commits).toHaveBeenCalledWith({ source: { kind: "thread", thread: owner, project } });
  expect(screen.getByRole("tabpanel", { name: "Commits" }).textContent).toBe("Execution commits");
  expect(screen.queryByText("Saved activity")).toBeNull();
});

it("opens task memory without an execution conversation", () => {
  show(null, "memory");
  expect(screen.getByText("No saved history yet")).toBeTruthy();
  expect(screen.queryByText("Saved activity")).toBeNull();
  expect(mocks.call).not.toHaveBeenCalled();
});

it("reports failed task memory reads and retries the same task", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Memory unavailable"));
  show(null, "memory", false, false);
  expect(await screen.findByText("Could not load memories")).toBeTruthy();
  expect(screen.queryByText("No saved history yet")).toBeNull();
  mocks.call.mockResolvedValueOnce({ memories: [], summaries: [] });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No saved history yet")).toBeTruthy();
  expect(mocks.call).toHaveBeenLastCalledWith("memory.forTask", { taskId: "task" });
});

it("keeps activity in its own tab", () => {
  show(null, "chat");
  expect(screen.getByRole("tabpanel", { name: "Activity" }).textContent).toBe("Saved activity");
  expect(mocks.changes).not.toHaveBeenCalled();
  expect(mocks.commits).not.toHaveBeenCalled();
});

it("opens Activity's file tools in the same task scope as its transcript links", () => {
  const { task, project } = show({ id: "executor", teamInstanceId: null }, "chat");
  expect(mocks.panel).toHaveBeenCalledWith({ context: { kind: "task", task, project } });
});

it("saves the overview before switching tabs and stays there if saving fails", async () => {
  show(null, "spec");
  mocks.flush.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  await waitFor(() => expect(mocks.flush).toHaveBeenCalledTimes(1));
  expect(useRouter.getState().route).toMatchObject({ tab: "spec" });
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  await waitFor(() => expect(useRouter.getState().route).toMatchObject({ tab: "memory" }));
});

it("does not return to a task after leaving while its save finishes", async () => {
  let saved: (ok: boolean) => void = () => {};
  mocks.flush.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        saved = resolve;
      }),
  );
  show(null, "spec");
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  useRouter.setState({ route: { view: "tasks" } });
  await act(async () => saved(true));
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
});

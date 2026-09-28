import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskView } from "./TaskView";

const mocks = vi.hoisted(() => ({ call: vi.fn(), panel: vi.fn(), setPanel: vi.fn(), setProject: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onInvalidate: () => {}, onReady: () => {} } }));
vi.mock("../lib/layout", () => ({ useLayout: (select: (state: unknown) => unknown) => select({ setPanel: mocks.setPanel, setProject: mocks.setProject }) }));
vi.mock("../components/Panel", () => ({
  Panel: (props: unknown) => {
    mocks.panel(props);
    return <div>Execution panel</div>;
  },
}));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../components/TaskActivity", () => ({ TaskActivity: () => <div>Saved activity</div> }));
vi.mock("./TaskDocument", () => ({ TaskDocument: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(owner: { id: string; teamInstanceId: string | null } | null, retainedTeam = false) {
  const task = { id: "task", projectId: "project", title: "Task B", status: "backlog", threadId: "creator", executionThreadId: owner?.id ?? null, baseSha: "viewed-diff" };
  const project = { id: "project", name: "Project" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["tasks.get", { id: task.id }], task);
  client.setQueryData(["projects.get", { id: project.id }], project);
  client.setQueryData(["tasks.executionThread", { taskId: task.id }], owner);
  client.setQueryData(["orchestration.taskState", { taskId: task.id }], retainedTeam ? { ownerDeletedAt: 1 } : null);
  render(
    <QueryClientProvider client={client}>
      <TaskView taskId={task.id} tab="files" />
    </QueryClientProvider>,
  );
  return { task, project };
}

it("shows pending execution without opening the creator's diff or assigning a conversation", () => {
  show(null);
  expect(screen.getByText("No execution yet")).toBeTruthy();
  expect(mocks.panel).not.toHaveBeenCalled();
  expect(mocks.call).not.toHaveBeenCalled();
});

it.each(["creator", "executor"])("routes the panel to the assigned %s conversation with an optional task label", (id) => {
  const owner = { id, teamInstanceId: null };
  const { task, project } = show(owner);
  expect(mocks.panel).toHaveBeenCalledWith({ context: { kind: "thread", thread: owner, project, task } });
  expect(mocks.call).not.toHaveBeenCalled();
});

it("keeps retained team reviews accessible after their conversation is deleted", () => {
  const { task, project } = show(null, true);
  expect(mocks.panel).toHaveBeenCalledWith({ context: { kind: "task", task, project } });
  expect(mocks.call).not.toHaveBeenCalled();
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, Task, TaskThreadLink, ThreadSummary } from "@openorc/protocol";
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => null), onReady: () => {}, onPush: () => () => {} } }));
vi.mock("../lib/task-document-draft", () => ({
  useTaskDocumentDraft: () => ({
    draft: { title: "Edit labels as chips", spec: "", labels: "" },
    imagesReady: true,
    draftStored: true,
    dirty: false,
    saving: false,
    saveError: null,
    error: null,
    reportError: () => {},
    flush: async () => true,
  }),
}));
vi.mock("../components/TaskExecutionSettings", () => ({
  TaskExecutionSettings: () => null,
  useTaskExecutionLocation: () => ({ runs: { data: [] }, wait: async () => true, isPending: false, branch: null, mode: "worktree" }),
}));
vi.mock("../components/task-refine/TaskRefine", () => ({ useTaskRefine: () => ({}) }));
vi.mock("../components/task-list/TaskDocumentFields", () => ({ TaskDocumentFields: () => null }));
vi.mock("../components/TaskComments", () => ({ TaskComments: () => null }));
vi.mock("../components/TaskDelete", () => ({ TaskDelete: () => null }));
vi.mock("../components/task-buttons/TaskFooterActions", () => ({ TaskFooterActions: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/task-threads/TaskThreadChoosers", () => ({
  OpenThreadChooser: () => null,
  ContinueThreadChooser: ({ thread }: { thread: ThreadSummary }) => <button type="button">Continue from {thread.id}</button>,
}));
import { TaskDocument } from "./TaskDocument";

const task = {
  id: "task",
  projectId: "project",
  title: "Edit labels as chips",
  status: "in_progress",
  threadId: "creator",
  executionThreadId: "current",
  createdAt: 1,
  worktreePath: null,
} as unknown as Task;
const project = { id: "project", name: "openorc", rootPath: "/repo", settings: {} } as unknown as Project;
const thread = (id: string, patch: Partial<ThreadSummary>) => ({ id, title: `Thread ${id}`, activity: "idle", hasStarted: true, lastActivityAt: 1, updatedAt: 1, ...patch }) as ThreadSummary;
afterEach(cleanup);

function show(links: TaskThreadLink[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["tasks.threads", { taskId: task.id }], links);
  render(
    <QueryClientProvider client={client}>
      <TaskDocument task={task} project={project} />
    </QueryClientProvider>,
  );
}

it("offers Continue for the current thread once it has worked and is quiet", () => {
  show([
    { thread: thread("earlier", {}), label: null, current: false },
    { thread: thread("current", {}), label: null, current: true },
  ]);
  expect(screen.getByRole("button", { name: "Continue from current" })).toBeTruthy();
});

it.each([
  ["is working", { activity: "running" }],
  ["needs the person", { activity: "waiting" }],
  ["hasn't started", { hasStarted: false }],
] as const)("offers no Continue while the current thread %s", (_, patch) => {
  show([{ thread: thread("current", patch), label: null, current: true }]);
  expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
});

it("offers no Continue from an earlier thread", () => {
  show([{ thread: thread("earlier", {}), label: null, current: false }]);
  expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
});

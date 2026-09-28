import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, Task } from "@openorc/protocol";
import { TaskDetailsPanel } from "./TaskDetailsPanel";

const fixture = vi.hoisted(() => ({
  mutate: vi.fn(),
  ownership: {} as { data?: unknown; isPending?: boolean; isError?: boolean },
  updatePending: false,
  updateError: null as Error | null,
}));
vi.mock("../lib/query", () => ({
  useRpc: (method: string) => (method === "orchestration.taskState" ? fixture.ownership : { data: method === "runs.listForTask" ? [] : undefined }),
  useRpcMutation: (method: string) => ({ mutate: fixture.mutate, isPending: method === "tasks.update" && fixture.updatePending, error: method === "tasks.update" ? fixture.updateError : null }),
}));
vi.mock("../components/TeamTaskStart", () => ({ TeamTaskStart: () => null, TeamTaskAdmissions: () => null }));
vi.mock("../components/TeamRetainedDelete", () => ({ DeleteRetainedOwnerContent: () => null }));
const task: Task = {
  id: "task",
  projectId: "project",
  title: "Task",
  spec: null,
  status: "backlog",
  priority: "none",
  labels: [],
  workspaceMode: "worktree",
  baseRef: null,
  baseSha: null,
  branch: null,
  worktreePath: "/tmp/fixture",
  parentTaskId: null,
  threadId: "thread",
  executionThreadId: null,
  origin: "agent",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
};
const project: Project = {
  id: "project",
  name: "Fixture",
  rootPath: "/tmp/fixture",
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixture.updatePending = false;
  fixture.updateError = null;
});

it.each([{ data: { working: true } }, { isPending: true }, { isError: true }])("allows a status move while execution controls remain protected: %j", (ownership) => {
  fixture.ownership = ownership;
  render(<TaskDetailsPanel task={task} project={project} />);
  const select = screen.getAllByRole("combobox")[0]!;
  expect(select.hasAttribute("disabled")).toBe(false);
  fireEvent.change(select, { target: { value: "done" } });
  expect(fixture.mutate).toHaveBeenCalledWith({ id: "task", patch: { status: "done" } });
  expect(screen.getByRole("button", { name: "Remove worktree" }).hasAttribute("disabled")).toBe(true);
});

it("uses loaded ownership over a stale load error when deciding workspace controls", () => {
  fixture.ownership = { data: { working: false }, isError: true };
  render(<TaskDetailsPanel task={task} project={project} />);
  expect(screen.queryByText(/Task ownership could not be checked/)).toBeNull();
  expect(screen.getByRole("button", { name: "Remove worktree" }).hasAttribute("disabled")).toBe(false);
});

it("follows external updates in pristine fields without replacing a local spec edit", () => {
  fixture.ownership = {};
  const original = { ...task, threadId: null, spec: "Original", labels: ["one"] };
  const mounted = render(<TaskDetailsPanel task={original} project={project} />);
  const spec = screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Spec/ });
  const labels = screen.getByRole<HTMLInputElement>("textbox", { name: /Labels/ });
  mounted.rerender(<TaskDetailsPanel task={{ ...original, spec: "Remote one", labels: ["two"] }} project={project} />);
  expect(spec.value).toBe("Remote one");
  expect(labels.value).toBe("two");
  fireEvent.change(spec, { target: { value: "My unsaved edit" } });
  mounted.rerender(<TaskDetailsPanel task={{ ...original, spec: "Remote two", labels: ["three"] }} project={project} />);
  expect(spec.value).toBe("My unsaved edit");
  expect(labels.value).toBe("three");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutate).toHaveBeenLastCalledWith({ id: "task", patch: { spec: "My unsaved edit", labels: ["three"] } });
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(spec.value).toBe("Remote two");
});

it("saves edited labels and priority through their separate field actions", () => {
  fixture.ownership = {};
  render(<TaskDetailsPanel task={{ ...task, threadId: null }} project={project} />);
  fireEvent.change(screen.getByRole<HTMLInputElement>("textbox", { name: /Labels/ }), { target: { value: " urgent, review , " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutate).toHaveBeenLastCalledWith({ id: "task", patch: { spec: null, labels: ["urgent", "review"] } });
  fireEvent.change(screen.getAllByRole<HTMLSelectElement>("combobox")[1]!, { target: { value: "high" } });
  expect(fixture.mutate).toHaveBeenLastCalledWith({ id: "task", patch: { priority: "high" } });
});

it("retains failed field edits for retry and disables competing saves while one is pending", () => {
  fixture.ownership = {};
  const mounted = render(<TaskDetailsPanel task={{ ...task, threadId: null }} project={project} />);
  const spec = screen.getByRole<HTMLTextAreaElement>("textbox", { name: /Spec/ });
  fireEvent.change(spec, { target: { value: "  Keep this draft  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutate).toHaveBeenLastCalledWith({ id: "task", patch: { spec: "Keep this draft", labels: [] } });
  fixture.updatePending = true;
  mounted.rerender(<TaskDetailsPanel task={{ ...task, threadId: null }} project={project} />);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" }).disabled).toBe(true);
  expect(screen.getAllByRole<HTMLSelectElement>("combobox")[1]!.disabled).toBe(true);
  fixture.updatePending = false;
  fixture.updateError = new Error("Save failed");
  mounted.rerender(<TaskDetailsPanel task={{ ...task, threadId: null }} project={project} />);
  expect(spec.value).toBe("  Keep this draft  ");
  expect(screen.getAllByText("Save failed")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutate).toHaveBeenCalledTimes(2);
  expect(fixture.mutate).toHaveBeenLastCalledWith({ id: "task", patch: { spec: "Keep this draft", labels: [] } });
});

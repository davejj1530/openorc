import type { Project } from "@openorc/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { TaskListRow } from "./TaskListRow";

vi.mock("../task-online/TaskRowControls", () => ({ TaskOnlineRowStatus: () => null, TaskOnlineOpen: () => null }));
vi.mock("../../lib/client", async (original) => ({ ...(await original<object>()), useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) }));

afterEach(cleanup);

/** An organization's project that lives only in the cloud, as the space's project list gives it. */
const cloudProject: Project & { cloud: true } = {
  id: "project-a",
  name: "Canvas",
  rootPath: "",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
  cloud: true,
};

function row(showProject: boolean) {
  const task = onlineTask();
  render(
    <TaskListRow
      record={{ kind: "online", task, reference: onlineReference, project: cloudProject }}
      project={cloudProject}
      showProject={showProject}
      current={false}
      onFocus={() => {}}
      onMoved={() => {}}
    />,
  );
}

it("draws one cloud mark on a task whose project is shown and lives only in the cloud", () => {
  row(true);
  expect(screen.getByText("Canvas")).toBeTruthy();
  expect(screen.queryByText("OpenOrc Cloud")).toBeNull();
});

it("keeps the task's own cloud mark when the row does not show its project", () => {
  row(false);
  expect(screen.getByText("OpenOrc Cloud")).toBeTruthy();
});

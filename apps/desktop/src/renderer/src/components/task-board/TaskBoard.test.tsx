import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { BoardColumn } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/client";
import { organizationContentGate } from "../../lib/organization-content-gate";
import { core } from "../../lib/rpc";
import type { BoardOwner } from "../../lib/task-board-source";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { taskAccess } from "../../lib/test-fixtures/task-access";
import { TaskBoard } from "./TaskBoard";

vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: vi.fn() } }));
vi.mock("../../lib/space-navigation", () => ({ useSpaceNavigation: () => null, spaceNavigation: { getState: () => ({ inventory: [] }) } }));
vi.mock("../../lib/space-queries", () => ({ useSpaceProjects: () => ({ data: [] }) }));

const column = (id: string, name: string, stage: BoardColumn["stage"]): BoardColumn => ({ id, projectId: onlineReference.projectId, name, stage, job: null, nextColumnId: null, jobEnabled: true });
const owner: BoardOwner = { place: "online", scope: { accountId: onlineReference.accountId, spaceId: onlineReference.spaceId }, projectId: onlineReference.projectId, key: "local-a" };
const card = { kind: "online" as const, task: onlineTask({ status: "in_progress", columnId: "build" }), reference: onlineReference, project: undefined };
const pane = { id: "pane", opened: null, onOpen: () => {} };
let mayEdit = false;

beforeEach(async () => {
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "spaces.status" || method === "spaces.refresh") return taskAccess();
    if (method === "tasks.online.board") return { revision: 1, columns: [column("backlog", "Backlog", "backlog"), column("build", "Build", "in_progress")], mayEdit };
    throw new Error(`Unexpected board RPC: ${method}`);
  });
  await organizationContentGate.refresh();
});
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  queryClient.clear();
  vi.clearAllMocks();
});
const show = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <TaskBoard tasks={[card]} owner={owner} showProject={false} pane={pane} />
    </QueryClientProvider>,
  );

it("shows a shared board's columns with no way to change them to a person who may not, and its cards still move", async () => {
  show();
  await screen.findByRole("heading", { name: "Build" });
  expect(screen.queryByRole("button", { name: "Build settings" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add column" })).toBeNull();
  expect(screen.getByText(card.task.title).closest("article")?.getAttribute("draggable")).toBe("true");
});

it("offers an admin the column settings and Add column", async () => {
  mayEdit = true;
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Add column" })).toBeTruthy());
  expect(screen.getByRole("button", { name: "Build settings" })).toBeTruthy();
});

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BoardColumn } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "./client";
import { organizationContentGate } from "./organization-content-gate";
import { core } from "./rpc";
import { useBoardColumns, type BoardOwner } from "./task-board-source";
import { taskAccess } from "./test-fixtures/task-access";

vi.mock("./rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: vi.fn() } }));
vi.mock("./space-navigation", () => ({ useSpaceNavigation: () => null, spaceNavigation: { getState: () => ({ inventory: [] }) } }));

const column = (id: string, name: string): BoardColumn => ({ id, projectId: "project-a", name, stage: "in_progress", job: null, nextColumnId: null, jobEnabled: true });
const owner: BoardOwner = { place: "online", scope: { accountId: "account-a", spaceId: "org:studio" }, projectId: "project-a", key: "local-a", runs: false };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
let board = { revision: 1, columns: [column("build", "Build")], mayEdit: true };
const saves: unknown[] = [];

beforeEach(async () => {
  board = { revision: 1, columns: [column("build", "Build")], mayEdit: true };
  saves.length = 0;
  vi.mocked(core.call).mockImplementation(async (method: string, input: unknown) => {
    if (method === "spaces.status" || method === "spaces.refresh") return taskAccess();
    if (method === "tasks.online.board") return board;
    if (method === "tasks.online.saveBoard") {
      saves.push(input);
      // A teammate saved first: the server keeps theirs and answers it.
      board = { revision: 2, columns: [column("build", "Build"), column("ship", "Ship")], mayEdit: true };
      return { state: "conflict", ...board };
    }
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

it("saves an organization's board from the revision it read, and a lost save reloads the board and says so", async () => {
  const { result } = renderHook(() => useBoardColumns(owner), { wrapper });
  await waitFor(() => expect(result.current.editable).toBe(true));
  expect(result.current.slots.map((each) => each.name)).toEqual(["Build"]);
  act(() => result.current.save([{ id: "build", name: "Building", stage: "in_progress" }]));
  await waitFor(() => expect(result.current.notice?.text).toBe("This board changed while you were editing it. It shows the latest columns now, so make your change again."));
  expect(saves).toEqual([expect.objectContaining({ spaceId: "org:studio", projectId: "project-a", ifRevision: 1, columns: [{ id: "build", name: "Building", stage: "in_progress" }] })]);
  await waitFor(() => expect(result.current.slots.map((each) => each.name)).toEqual(["Build", "Ship"]));
});

it("offers no change to a shared board the person may not change", async () => {
  board = { ...board, mayEdit: false };
  const { result } = renderHook(() => useBoardColumns(owner), { wrapper });
  await waitFor(() => expect(result.current.slots.map((each) => each.name)).toEqual(["Build"]));
  expect(result.current.editable).toBe(false);
});

it("saves a change to the board of all projects to each project that has the column, and reads the union again", async () => {
  let kept: BoardColumn[] = [
    { ...column("app-build", "Build"), projectId: "app" },
    { ...column("site-build", "Build"), projectId: "site" },
    { ...column("site-qa", "QA"), projectId: "site" },
  ];
  const projectSaves: unknown[] = [];
  vi.mocked(core.call).mockImplementation(async (method: string, input: unknown) => {
    if (method === "board.allColumns") return kept;
    if (method === "board.saveColumns") {
      const { projectId, columns } = input as { projectId: string; columns: { id: string; name: string }[] };
      projectSaves.push([projectId, columns.map((each) => each.name)]);
      kept = kept.map((each) => ({ ...each, name: columns.find((saved) => saved.id === each.id)?.name ?? each.name }));
      return kept.filter((each) => each.projectId === projectId);
    }
    throw new Error(`Unexpected board RPC: ${method}`);
  });
  const union: BoardOwner = { place: "union", projectIds: ["app", "site"] };
  const { result } = renderHook(() => useBoardColumns(union), { wrapper });
  await waitFor(() => expect(result.current.slots.map((each) => each.name)).toEqual(["Build", "QA"]));
  expect(result.current.union?.map((each) => each.members.length)).toEqual([2, 1]);
  act(() => result.current.save(result.current.slots.map((slot) => (slot.name === "Build" ? { ...slot, name: "Make" } : slot))));
  await waitFor(() => expect(result.current.saving).toBe(false));
  expect(projectSaves).toEqual([
    ["app", ["Make"]],
    ["site", ["Make", "QA"]],
  ]);
  // The core announces the change, and the board reads every project's columns again.
  await act(() => queryClient.invalidateQueries());
  await waitFor(() => expect(result.current.slots.map((each) => each.name)).toEqual(["Make", "QA"]));
});

it("saves a change to an organization's board of all projects to each project's board from the revision it was read at, and stops at one another save overtook", async () => {
  const teamColumn = (id: string, projectId: string, name: string): BoardColumn => ({ ...column(id, name), projectId });
  const boards = [
    { projectId: "app", revision: 3, columns: [teamColumn("app-build", "app", "Build")], mayEdit: true },
    { projectId: "site", revision: 7, columns: [teamColumn("site-build", "site", "Build"), teamColumn("site-qa", "site", "QA")], mayEdit: true },
  ];
  const saves: { projectId: string; ifRevision: number; names: string[] }[] = [];
  vi.mocked(core.call).mockImplementation(async (method: string, input: unknown) => {
    if (method === "spaces.status" || method === "spaces.refresh") return taskAccess();
    if (method === "tasks.online.boards") return boards;
    if (method === "tasks.online.saveBoard") {
      const { projectId, ifRevision, columns } = input as { projectId: string; ifRevision: number; columns: { name: string }[] };
      saves.push({ projectId, ifRevision, names: columns.map((each) => each.name) });
      // The second project's board was saved by a teammate since it was read.
      return projectId === "site" ? { state: "conflict", ...boards[1]! } : { state: "saved", ...boards[0]! };
    }
    throw new Error(`Unexpected board RPC: ${method}`);
  });
  const team: BoardOwner = {
    place: "team-union",
    scope: { accountId: "account-a", spaceId: "org:studio" },
    projectIds: ["app", "site"],
    names: new Map([
      ["app", "App"],
      ["site", "Site"],
    ]),
    runs: true,
  };
  const { result } = renderHook(() => useBoardColumns(team), { wrapper });
  await waitFor(() => expect(result.current.slots.map((each) => each.name)).toEqual(["Build", "QA"]));
  expect(result.current.editable).toBe(true);
  act(() => result.current.save(result.current.slots.map((slot) => (slot.name === "Build" ? { ...slot, name: "Make" } : slot))));
  await waitFor(() => expect(result.current.notice?.text).toMatch(/^A project's board changed while you were editing it\./));
  expect(saves).toEqual([
    { projectId: "app", ifRevision: 3, names: ["Make"] },
    { projectId: "site", ifRevision: 7, names: ["Make", "QA"] },
  ]);
});

it("keeps the statuses, and changes nothing, with no board owner", () => {
  const { result } = renderHook(() => useBoardColumns(null), { wrapper });
  expect(result.current).toMatchObject({ ready: true, union: null, editable: false, notice: null });
});

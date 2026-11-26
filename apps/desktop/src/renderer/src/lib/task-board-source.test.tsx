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
const owner: BoardOwner = { place: "online", scope: { accountId: "account-a", spaceId: "org:studio" }, projectId: "project-a", key: "local-a" };
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
  expect(result.current.columns?.map((each) => each.name)).toEqual(["Build"]);
  act(() => result.current.save([{ id: "build", name: "Building", stage: "in_progress" }]));
  await waitFor(() => expect(result.current.notice?.text).toBe("This board changed while you were editing it. It shows the latest columns now, so make your change again."));
  expect(saves).toEqual([expect.objectContaining({ spaceId: "org:studio", projectId: "project-a", ifRevision: 1, columns: [{ id: "build", name: "Building", stage: "in_progress" }] })]);
  await waitFor(() => expect(result.current.columns?.map((each) => each.name)).toEqual(["Build", "Ship"]));
});

it("offers no change to a shared board the person may not change", async () => {
  board = { ...board, mayEdit: false };
  const { result } = renderHook(() => useBoardColumns(owner), { wrapper });
  await waitFor(() => expect(result.current.columns?.map((each) => each.name)).toEqual(["Build"]));
  expect(result.current.editable).toBe(false);
});

it("keeps the statuses, and changes nothing, with no board owner", () => {
  const { result } = renderHook(() => useBoardColumns(null), { wrapper });
  expect(result.current).toMatchObject({ columns: [], editable: false, notice: null });
});

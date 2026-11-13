import { Menu } from "@base-ui/react/menu";
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => {
    if (method === "projects.checkoutBranch") return { isSuccess: true, data: "main" };
    if (method === "projects.get") return { isSuccess: true, data: { id: "p1", rootPath: "/repo" } };
    return { isSuccess: false, data: undefined };
  },
  useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));
vi.mock("../lib/orclings", () => ({ useOrclings: () => [], orclingHome: () => null }));

import { CoversPreview } from "../lib/browser-preview";
import { useUi } from "../lib/ui";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";

const base = {
  id: "t1",
  title: "Thread",
  projectId: "p1",
  agent: "codex",
  activity: "idle",
  unread: true,
  workspaceMode: "worktree",
  branch: "fix/menu",
  worktreePath: "/worktrees/fix-menu",
  parentThreadId: "home",
  parentRelation: "started",
  queued: [],
} as unknown as ThreadSummary;

const revealFile = vi.fn();
const writeText = vi.fn(async () => {});

function open(thread: Partial<ThreadSummary>, header?: { onRename: () => void }): void {
  render(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={{ ...base, ...thread }} parts={Menu as unknown as MenuParts} {...(header ? { header: true, onRename: header.onRename } : {})} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
}

beforeEach(() => {
  revealFile.mockClear();
  writeText.mockClear();
  Object.assign(window, { openorc: { ...window.openorc, revealFile, openWindow: vi.fn() } });
  Object.assign(navigator, { clipboard: { writeText } });
  useUi.getState().setMoveThread(null);
});
afterEach(cleanup);

it("leaves the open thread's header without ways to open it again or mark it unread, and renames it", () => {
  const onRename = vi.fn();
  open({}, { onRename });
  for (const gone of ["Open in new tab", "Open beside", "Open parent", "Mark as unread", "Mark as read"]) expect(screen.queryByText(gone)).toBeNull();
  expect(screen.getByText("Open in new window")).toBeTruthy();
  fireEvent.click(screen.getByText("Rename"));
  expect(onRename).toHaveBeenCalled();
});

it("keeps every way to open a sidebar row's thread, and no Rename", () => {
  open({});
  for (const kept of ["Open in new tab", "Open beside", "Open in new window", "Open parent", "Mark as read"]) expect(screen.getByText(kept)).toBeTruthy();
  expect(screen.queryByText("Rename")).toBeNull();
});

it("names a worktree thread's branch, and its submenu reveals the worktree, copies the branch and moves to the checkout", async () => {
  open({}, { onRename: vi.fn() });
  expect(screen.getByText("Worktree")).toBeTruthy();
  fireEvent.click(screen.getByText("fix/menu"));
  fireEvent.click(await screen.findByText("Show in Finder"));
  expect(revealFile).toHaveBeenCalledWith("/worktrees/fix-menu");
  fireEvent.click(screen.getByText("fix/menu"));
  fireEvent.click(await screen.findByText("Copy branch name"));
  expect(writeText).toHaveBeenCalledWith("fix/menu");
  fireEvent.click(screen.getByText("fix/menu"));
  fireEvent.click(await screen.findByText("Move to the checkout"));
  expect(useUi.getState().moveThreadId).toBe("t1");
});

it("reads a checkout thread's branch live, since the checkout can switch under it", async () => {
  open({ workspaceMode: "current", branch: "old-branch", worktreePath: null }, { onRename: vi.fn() });
  expect(screen.queryByText("old-branch")).toBeNull();
  expect(screen.getByText("Checkout")).toBeTruthy();
  fireEvent.click(screen.getByText("main"));
  fireEvent.click(await screen.findByText("Show in Finder"));
  expect(revealFile).toHaveBeenCalledWith("/repo");
  fireEvent.click(screen.getByText("main"));
  expect((await screen.findByText("Move to a worktree")).closest("[role=menuitem]")?.getAttribute("aria-disabled")).not.toBe("true");
});

it("holds the folder move while the agent works", async () => {
  open({ activity: "running" }, { onRename: vi.fn() });
  fireEvent.click(screen.getByText("fix/menu"));
  expect((await screen.findByText("Move to the checkout")).closest("[role=menuitem]")?.getAttribute("aria-disabled")).toBe("true");
});

it("offers to remove an idle worktree thread's worktree, through its confirm", async () => {
  useUi.getState().setRemoveWorktree(null);
  open({}, { onRename: vi.fn() });
  fireEvent.click(screen.getByText("fix/menu"));
  const item = (await screen.findByText("Remove worktree")).closest("[role=menuitem]");
  expect(item?.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(item!);
  expect(useUi.getState().removeWorktreeThreadId).toBe("t1");
});

it("holds worktree removal while the agent works, and offers none in the checkout", async () => {
  open({ activity: "running" }, { onRename: vi.fn() });
  fireEvent.click(screen.getByText("fix/menu"));
  expect((await screen.findByText("Remove worktree")).closest("[role=menuitem]")?.getAttribute("aria-disabled")).toBe("true");
  cleanup();
  open({ workspaceMode: "current", worktreePath: null }, { onRename: vi.fn() });
  fireEvent.click(screen.getByText("main"));
  await screen.findByText("Move to a worktree");
  expect(screen.queryByText("Remove worktree")).toBeNull();
});

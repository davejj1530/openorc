import { Menu } from "@base-ui/react/menu";
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => (method === "threads.get" ? { isSuccess: true, isPending: false, data: deleting } : { isSuccess: true, data: { offered: false, brain: null } }),
  useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));
vi.mock("../lib/orclings", () => ({ useOrclings: () => [], useOrclingGroups: () => [], orclingHome: () => null }));

import { CoversPreview } from "../lib/browser-preview";
import { routeFromSpec, specFromRoute, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { DeleteThreadDialog, ThreadMenuItems, type MenuParts } from "./ThreadActions";

let deleting: ThreadSummary | undefined;
const base = { id: "t1", title: "Thread", projectId: "p1", agent: "codex", activity: "idle", openTaskCount: 0, workspaceMode: "worktree", queued: [] } as unknown as ThreadSummary;

function open(thread: Partial<ThreadSummary>, header?: boolean): void {
  render(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={{ ...base, ...thread }} parts={Menu as unknown as MenuParts} header={header} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
}

beforeEach(() => useRouter.getState().navigate({ view: "thread", threadId: "t1" }));
afterEach(cleanup);

it("starts a subthread under the thread, and a window reopens that screen", () => {
  open({});
  expect(screen.queryByText("Open parent")).toBeNull();
  fireEvent.click(screen.getByText("New subthread"));
  const route = useRouter.getState().route;
  expect(route).toEqual({ view: "newsubthread", parentId: "t1" });
  expect(routeFromSpec(specFromRoute(route))).toEqual(route);
});

it("opens a subthread's parent, whoever started it", () => {
  open({ parentThreadId: "home", parentRelation: "started" });
  fireEvent.click(screen.getByText("Open parent"));
  expect(useRouter.getState().route).toMatchObject({ view: "thread", threadId: "home" });
});

it("leads a sidebar row's menu with New subthread, and keeps it beside Fork in the header", () => {
  open({});
  const sidebar = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
  expect(sidebar.slice(0, 2)).toEqual(["New subthread", "Open in new tab"]);
  expect(sidebar.filter((label) => label === "New subthread")).toHaveLength(1);
  cleanup();
  open({}, true);
  const header = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
  expect(header.indexOf("Fork") - header.indexOf("New subthread")).toBe(1);
});

it("says a subthread's delete removes only its conversation, wherever it runs", () => {
  for (const owner of [undefined, { brain: "hosted", reach: "live", heardAt: 1 }]) {
    deleting = { ...base, parentThreadId: "home", parentRelation: "started", worktreePath: "/worktrees/home", owner } as ThreadSummary;
    useUi.getState().setDeleteThread("t1");
    render(<DeleteThreadDialog />);
    expect(screen.getByRole("dialog").textContent).toContain("This conversation is removed. The folder and its work stay with the parent thread.");
    useUi.getState().setDeleteThread(null);
    cleanup();
  }
});

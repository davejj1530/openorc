import { Menu } from "@base-ui/react/menu";
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: () => ({ isSuccess: true, data: { offered: false, brain: null } }),
  useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));
vi.mock("../lib/orclings", () => ({ useOrclings: () => [], orclingHome: () => null }));

import { CoversPreview } from "../lib/browser-preview";
import { routeFromSpec, specFromRoute, useRouter } from "../lib/router";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";

const base = { id: "t1", title: "Thread", projectId: "p1", agent: "codex", activity: "idle", openTaskCount: 0, workspaceMode: "worktree", queued: [] } as unknown as ThreadSummary;

function open(thread: Partial<ThreadSummary>): void {
  render(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={{ ...base, ...thread }} parts={Menu as unknown as MenuParts} />
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

it("keeps New subthread for this Mac's threads", () => {
  open({ owner: { brain: "cloud", reach: "live", heardAt: 1 } });
  expect(screen.getByText("New subthread").closest("[role=menuitem]")?.getAttribute("title")).toBe("Bring it to this Mac first.");
});

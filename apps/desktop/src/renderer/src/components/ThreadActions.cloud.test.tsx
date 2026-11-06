import { Menu } from "@base-ui/react/menu";
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { mutations, offer } = vi.hoisted(() => ({
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  offer: { brain: null as null | { host: string; projects: [] }, provider: "vercel" as "vercel" | null },
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ isSuccess: true, data: method === "cloud.offer" ? { offered: true, provider: offer.provider, brain: offer.brain } : [] }),
  useRpcMutation: (method: string) => {
    if (!mutations.has(method)) mutations.set(method, vi.fn());
    return { mutate: mutations.get(method), isPending: false, error: null };
  },
}));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));
vi.mock("../lib/orclings", () => ({ useOrclings: () => [], orclingHome: () => null }));

import { CoversPreview } from "../lib/browser-preview";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";

const base = { id: "t1", title: "Thread", projectId: "p1", agent: "claude", activity: "idle", openTaskCount: 0, workspaceMode: "worktree", queued: [] } as unknown as ThreadSummary;

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

beforeEach(() => {
  mutations.clear();
  offer.brain = { host: "brain-key", projects: [] };
  offer.provider = "vercel";
});
afterEach(cleanup);

it("offers Bring to Mac for a thread the cloud brain holds, and no folder moves or fork", () => {
  open({ owner: { brain: "cloud", reach: "live", heardAt: 1 } });
  fireEvent.click(screen.getByText("Bring to Mac"));
  expect(mutations.get("cloud.bringToMac")).toHaveBeenCalledWith({ threadId: "t1" });
  expect(screen.queryByText("Move to cloud")).toBeNull();
  expect(screen.queryByText("Move to a worktree")).toBeNull();
  expect(screen.getByText("Fork").closest("[role=menuitem]")?.getAttribute("title")).toBe("Bring it to this Mac first.");
});

it("offers to keep a moving thread where it was", () => {
  open({ moving: { to: "cloud", since: 1 } });
  fireEvent.click(screen.getByText("Keep on this Mac"));
  expect(mutations.get("cloud.keep")).toHaveBeenCalledWith({ threadId: "t1" });
});

it("offers Move to cloud for every agent's conversation, the brain checking again when asked", () => {
  for (const agent of ["claude", "codex", "opencode"] as const) {
    open({ agent });
    const item = screen.getAllByText("Move to cloud").at(-1)!.closest("[role=menuitem]");
    expect(item?.getAttribute("aria-disabled")).not.toBe("true");
    expect(item?.getAttribute("title")).toBeNull();
  }
});

it("keeps today's sandbox move without a brain", () => {
  offer.brain = null;
  open({ agent: "codex" });
  expect(screen.getByText("Move to cloud").closest("[role=menuitem]")?.getAttribute("aria-disabled")).not.toBe("true");
});

it("says what to connect when there is no brain and no cloud service to move to", () => {
  offer.brain = null;
  offer.provider = null;
  open({ agent: "claude" });
  const item = screen.getByText("Move to cloud").closest("[role=menuitem]");
  expect(item?.getAttribute("aria-disabled")).toBe("true");
  expect(item?.getAttribute("title")).toBe("Connect Vercel or Agent37 in Settings > Cloud first.");
});

import { Menu } from "@base-ui/react/menu";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMoveCheck, RpcMethod, RpcResults, ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";

// This computer runs Linux: every word about it says "this computer", never Mac.
vi.hoisted(() => Object.assign(globalThis, { openorc: { ...(globalThis as { openorc?: object }).openorc, platform: "linux" } }));
vi.mock("../lib/orclings", () => ({ useOrclings: () => [], useOrclingGroups: () => [], orclingHome: () => null }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));

import { CoversPreview } from "../lib/browser-preview";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useHostedComposer } from "./HostedSendNotice";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { cloudReviewThread } from "./test-fixtures/hosted-review";

const cloudThread: ThreadSummary = { ...cloudReviewThread, agent: "claude" };
const check: CloudMoveCheck = { to: "mac", can: true, ends: [] };

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "threads.moveCheck") return check as RpcResults[M];
    if (method === "hosted.capabilities") return { version: 1, features: {} } as RpcResults[M];
    return null as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (element: ReactNode) => render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);

function Composer({ thread }: { thread: ThreadSummary }) {
  const cloud = useHostedComposer(thread, { choice: null, mode: "act", permission: "review" }, { current: null }, "");
  return (
    <>
      {cloud.notice}
      <output>{cloud.limits.readOnlyReason}</output>
    </>
  );
}

it("names this computer as the app does on Linux, in the control, the moving line and the card", async () => {
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={cloudThread} parts={Menu as unknown as MenuParts} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  expect(await screen.findByRole("menuitem", { name: /^Move to this computer$/ })).toBeTruthy();
  expect(screen.queryByText(/Mac/)).toBeNull();
  cleanup();
  mount(<Composer thread={{ ...cloudThread, moving: { to: "mac", failed: null } }} />);
  expect(screen.getByRole("status").textContent).toBe("Moving to this computer");
  cleanup();
  const folder = "/home/ada/.config/OpenOrc/worktrees/app-1a2b3c/thread-fix-the-login-6f1c2d";
  mount(<Composer thread={{ ...cloudThread, moving: { to: "mac", failed: "A folder for this thread is already where its worktree goes, with other work in it.", folder } }} />);
  expect(screen.getByRole("status", { name: "Move" }).textContent).toContain("Didn't move to this computer.");
  expect(screen.getByRole("button", { name: `Show in folder: ${folder}` }).textContent).toBe("~/.config/OpenOrc/worktrees/app-1a2b3c/thread-fix-the-login-6f1c2d");
});

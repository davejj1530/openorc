import { Menu } from "@base-ui/react/menu";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MOVING_TO_CLOUD,
  type AccountStatus,
  type CloudCopy,
  type CloudMoveCheck,
  type CloudMoveStart,
  type RpcMethod,
  type RpcResults,
  type SpacesStatus,
  type ThreadSummary,
} from "@openorc/protocol";
import type { ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { queryClient } from "../lib/client";
import { OrganizationContext, type OrganizationActions } from "../lib/organization-context";
import { core } from "../lib/rpc";
import { useUi } from "../lib/ui";
import { CloudMoveDialog } from "./CloudMoveDialog";
import { useHostedComposer } from "./HostedSendNotice";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { cloudReviewThread, localReviewThread } from "./test-fixtures/hosted-review";

vi.mock("../lib/orclings", () => ({ useOrclings: () => [], useOrclingGroups: () => [], orclingHome: () => null }));
vi.mock("../lib/thread-mutations", () => ({ useThreadMutationPending: () => false }));

const macThread: ThreadSummary = { ...localReviewThread, agent: "claude" };
const cloudThread: ThreadSummary = { ...cloudReviewThread, agent: "claude" };

const pro: AccountStatus = {
  state: "signed-in",
  email: "ada@example.com",
  name: "Ada Lovelace",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 0 },
  hours: { leftSeconds: 3600, monthly: { grantedSeconds: 3600, leftSeconds: 3600, resetsAt: 0 }, packsLeftSeconds: 0 },
  sandbox: null,
  signIns: [{ agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }],
  signingIn: {},
  github: null,
  connectingGithub: null,
  paying: null,
  projects: [],
  error: null,
};

const spaces = {
  state: "ready",
  userId: "ada",
  apiOrigin: "https://api.example.com",
  personalSpaceId: "personal",
  spaces: [
    { kind: "personal", id: "personal" },
    { kind: "organization", id: "acme", name: "Acme Robotics" },
  ],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
} as unknown as SpacesStatus;

let check: CloudMoveCheck;
let moveAnswer: CloudMoveStart;
let copyAnswer: CloudCopy | Error;
let account: AccountStatus;

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useUi.getState().setCloudMove(null);
  check = { to: "cloud", can: true, space: { id: "personal", personal: true } };
  account = pro;
  moveAnswer = { started: true };
  copyAnswer = {
    folder: "/Users/ada/Library/Application Support/OpenOrc/cloud-copies/cloud-example",
    savedAt: "2026-11-18T01:00:00.000Z",
    head: "abc1234",
    asOf: { turnId: null, at: "2026-11-18T01:00:00.000Z" },
  };
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params?: unknown): Promise<RpcResults[M]> => {
    const answer: Partial<Record<RpcMethod, unknown>> = {
      "threads.moveCheck": check,
      "account.status": account,
      "threads.get": (params as { id: string }).id === cloudThread.id ? cloudThread : macThread,
      "threads.move": moveAnswer,
      "threads.moveDismiss": null,
      "threads.cloudCopy": copyAnswer,
      "projects.checkoutBranch": "main",
      "projects.get": null,
      "hosted.capabilities": { version: 1, features: {} },
    };
    if (answer[method] instanceof Error) throw answer[method];
    if (method in answer) return answer[method] as RpcResults[M];
    throw new Error(`Unexpected read: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const organization = { status: spaces } as OrganizationActions;
const mount = (element: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationContext.Provider value={organization}>
        {element}
        <CloudMoveDialog />
      </OrganizationContext.Provider>
    </QueryClientProvider>,
  );

function openMenu(thread: ThreadSummary, close?: () => void) {
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={thread} parts={Menu as unknown as MenuParts} close={close} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
}

/** Every read asked is answered: the move's check and the account are in. */
const settled = () => vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
const moves = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "threads.move");

it("moves a Mac thread of the person's own space to OpenOrc Cloud from its branch's submenu, asking nothing", async () => {
  openMenu(macThread);
  fireEvent.click(screen.getByText("example"));
  await settled();
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to OpenOrc Cloud/ }));
  await vi.waitFor(() => expect(moves()).toEqual([["threads.move", { threadId: macThread.id, endsOk: false }]]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("names the team's space a move to the cloud lands in before the move", async () => {
  check = { to: "cloud", can: true, space: { id: "acme", personal: false } };
  openMenu(macThread);
  fireEvent.click(screen.getByText("example"));
  await settled();
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to OpenOrc Cloud/ }));
  const dialog = await screen.findByRole("dialog", { name: "Move to OpenOrc Cloud?" });
  expect(await within(dialog).findByText("Everyone in Acme Robotics can read it there.")).toBeTruthy();
  const move = within(dialog).getByRole("button", { name: "Move" });
  await vi.waitFor(() => expect(move.hasAttribute("disabled")).toBe(false));
  fireEvent.click(move);
  await vi.waitFor(() => expect(moves()).toEqual([["threads.move", { threadId: macThread.id, endsOk: true }]]));
  await vi.waitFor(() => expect(useUi.getState().cloudMove).toBeNull());
});

it("asks after all when leaving the cloud machine turns out to end something as the move starts", async () => {
  check = { to: "mac", can: true, ends: [] };
  moveAnswer = { confirm: ["pnpm dev"] };
  openMenu(cloudThread);
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  await settled();
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to Mac/ }));
  await vi.waitFor(() => expect(useUi.getState().cloudMove).toEqual({ threadId: cloudThread.id, error: null }));
});

it("holds a move to the cloud with the words a cloud start is held with", async () => {
  account = { ...pro, plan: { pro: false, standing: "live", at: 0 } } as AccountStatus;
  openMenu(macThread);
  fireEvent.click(screen.getByText("example"));
  await settled();
  const item = screen.getByRole("menuitem", { name: /Move to OpenOrc Cloud/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item.focus());
  expect(await screen.findByText(/Pro/)).toBeTruthy();
});

it("offers no move to a person with no account", async () => {
  account = { state: "signed-out", ended: false } as AccountStatus;
  openMenu(macThread);
  fireEvent.click(screen.getByText("example"));
  await screen.findByText("Move to the checkout");
  await settled();
  expect(screen.queryByText(/Move to OpenOrc Cloud/)).toBeNull();
});

it("moves a cloud thread to this computer, naming what leaving its machine ends", async () => {
  check = { to: "mac", can: true, ends: ["pnpm dev", "a terminal"] };
  openMenu(cloudThread);
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  await settled();
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to Mac/ }));
  const dialog = await screen.findByRole("dialog", { name: "Move to this Mac?" });
  await settled();
  expect(await within(dialog).findByText("Leaving its cloud machine ends:")).toBeTruthy();
  expect(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["pnpm dev", "a terminal"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
  await vi.waitFor(() => expect(moves()).toEqual([["threads.move", { threadId: cloudThread.id, endsOk: true }]]));
});

it("holds a cloud thread of a team's space where it is, with why", async () => {
  check = { to: "mac", can: false, reason: "Only a thread in your own space can move to this Mac." };
  openMenu(cloudThread);
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  await settled();
  const item = screen.getByRole("menuitem", { name: /Move to Mac/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item.focus());
  expect(await screen.findByText("Only a thread in your own space can move to this Mac.")).toBeTruthy();
});

it("says where a moving thread is going in place of its place rows", () => {
  openMenu({ ...macThread, moving: { to: "cloud", failed: null } });
  expect(screen.getByRole("menuitem", { name: MOVING_TO_CLOUD }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.queryByText("example")).toBeNull();
});

function Composer({ thread }: { thread: ThreadSummary }) {
  const cloud = useHostedComposer(thread, { choice: null, mode: "act", permission: "review" }, { current: null }, "");
  return (
    <>
      {cloud.notice}
      <output>{cloud.limits.readOnlyReason ?? "writable"}</output>
    </>
  );
}

it("takes no message while the thread moves, from either side", () => {
  mount(<Composer thread={{ ...macThread, moving: { to: "cloud", failed: null } }} />);
  expect(screen.getByRole("status").textContent).toBe(MOVING_TO_CLOUD);
  cleanup();
  mount(<Composer thread={{ ...cloudThread, moving: { to: "mac", failed: null } }} />);
  expect(screen.getAllByRole("status").at(-1)?.textContent).toBe("Moving to Mac");
});

it("says why a move stopped above the composer, puts it away, and moves again", async () => {
  mount(<Composer thread={{ ...macThread, moving: { to: "cloud", failed: "The thread didn't leave its cloud machine in time. Try again." } }} />);
  expect(screen.getByText("writable")).toBeTruthy();
  expect(screen.getByRole("status", { name: "Move" }).textContent).toContain("Didn't move to OpenOrc Cloud. The thread didn't leave its cloud machine in time.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await vi.waitFor(() => expect(vi.mocked(core.call)).toHaveBeenCalledWith("threads.moveDismiss", { threadId: macThread.id }));
  await settled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(moves()).toEqual([["threads.move", { threadId: macThread.id, endsOk: false }]]));
});

it("names the folder that stopped a move as the person reads paths, and opens it", async () => {
  const folder = "/Users/ada/Library/Application Support/OpenOrc/worktrees/app-1a2b3c/thread-fix-the-login-6f1c2d";
  const revealFile = vi.fn();
  Object.assign(window, { openorc: { ...window.openorc, revealFile } });
  mount(<Composer thread={{ ...cloudThread, moving: { to: "mac", failed: "A folder for this thread is already where its worktree goes, with other work in it.", folder } }} />);
  const path = screen.getByRole("button", { name: `Show in Finder: ${folder}` });
  expect(path.textContent).toBe("~/Library/Application Support/OpenOrc/worktrees/app-1a2b3c/thread-fix-the-login-6f1c2d");
  expect(path.getAttribute("data-tip")).toBe(folder);
  fireEvent.click(path);
  expect(revealFile).toHaveBeenCalledWith(folder);
});

it("opens a cloud thread's code on this computer, a copy of its newest save, in the file manager, then closes the menu", async () => {
  const revealFile = vi.fn();
  const close = vi.fn(() => expect(revealFile).toHaveBeenCalled());
  Object.assign(window, { openorc: { ...window.openorc, revealFile } });
  openMenu(cloudThread, close);
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Open on Mac/ }));
  await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith("/Users/ada/Library/Application Support/OpenOrc/cloud-copies/cloud-example"));
  expect(close, "once the copy is shown, not when it is chosen").toHaveBeenCalledTimes(1);
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("threads.cloudCopy", { threadId: cloudThread.id });
});

it("holds Open on this computer with why when the copy can't be made", async () => {
  copyAnswer = new Error("This project isn't on this Mac.");
  openMenu(cloudThread);
  fireEvent.click(screen.getByText("OpenOrc Cloud"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Open on Mac/ }));
  await vi.waitFor(() => expect(screen.getByRole("menuitem", { name: /Open on Mac/ }).getAttribute("aria-disabled")).toBe("true"));
  await act(async () => screen.getByRole("menuitem", { name: /Open on Mac/ }).focus());
  expect(await screen.findByText("This project isn't on this Mac.")).toBeTruthy();
});

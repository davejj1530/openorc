import { Menu } from "@base-ui/react/menu";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOVING_TO_CLOUD, type AccountStatus, type CloudMoveCheck, type RpcMethod, type RpcResults, type SpacesStatus, type ThreadSummary } from "@openorc/protocol";
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
let account: AccountStatus;

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useUi.getState().setCloudMove(null);
  check = { to: "cloud", can: true, space: { id: "personal", personal: true } };
  account = pro;
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params?: unknown): Promise<RpcResults[M]> => {
    const answer: Partial<Record<RpcMethod, unknown>> = {
      "threads.moveCheck": check,
      "account.status": account,
      "threads.get": (params as { id: string }).id === cloudThread.id ? cloudThread : macThread,
      "threads.move": { started: true },
      "threads.moveDismiss": null,
      "projects.checkoutBranch": "main",
      "projects.get": null,
      "hosted.capabilities": { version: 1, features: {} },
    };
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

function openMenu(thread: ThreadSummary) {
  mount(
    <Menu.Root open>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner>
          <Menu.Popup>
            <ThreadMenuItems thread={thread} parts={Menu as unknown as MenuParts} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>,
  );
}

/** Every read asked is answered: the move's check and the account are in. */
const settled = () => vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
const moves = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "threads.move");

it("moves a Mac thread to OpenOrc Cloud from its branch's submenu, through one confirm", async () => {
  openMenu(macThread);
  fireEvent.click(screen.getByText("example"));
  await settled();
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to OpenOrc Cloud/ }));
  const dialog = await screen.findByRole("dialog", { name: "Move to OpenOrc Cloud?" });
  expect(await within(dialog).findByText(macThread.title)).toBeTruthy();
  const move = within(dialog).getByRole("button", { name: "Move" });
  await vi.waitFor(() => expect(move.hasAttribute("disabled")).toBe(false));
  expect(within(dialog).queryByText(/can read it there/)).toBeNull();
  fireEvent.click(move);
  await vi.waitFor(() => expect(moves()).toEqual([["threads.move", { threadId: macThread.id, endsOk: true }]]));
  await vi.waitFor(() => expect(useUi.getState().cloudMoveThreadId).toBeNull());
});

it("names the team's space a move to the cloud lands in before the move", async () => {
  check = { to: "cloud", can: true, space: { id: "acme", personal: false } };
  useUi.getState().setCloudMove(macThread.id);
  mount(null);
  const dialog = await screen.findByRole("dialog", { name: "Move to OpenOrc Cloud?" });
  expect(await within(dialog).findByText("Everyone in Acme Robotics can read it there.")).toBeTruthy();
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
  expect(await within(dialog).findByText("Leaving its cloud machine ends pnpm dev and a terminal.")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("dialog", { name: "Move to OpenOrc Cloud?" })).toBeTruthy();
});

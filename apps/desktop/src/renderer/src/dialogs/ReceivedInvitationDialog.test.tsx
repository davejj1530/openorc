import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReceivedInvitation, SpacesStatus } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { useReceivedInvitations } from "../lib/received-invitations";
import { ReceivedInvitationDialog } from "./ReceivedInvitationDialog";

const mock = vi.hoisted(() => ({ call: vi.fn(), select: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
const invitation: ReceivedInvitation = {
  id: "invite",
  email: "mira@example.com",
  role: "member",
  expiresAt: Date.now() + 86400000,
  organization: { id: "birch", name: "Birch Studio", logo: null },
  inviter: { name: "Alex Rivera", email: "alex@example.com" },
};
let status: Extract<SpacesStatus, { state: "ready" }>;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  status = {
    state: "ready",
    userId: "mira",
    apiOrigin: "https://api.example.com",
    personalSpaceId: "personal",
    spaces: [{ id: "personal", kind: "personal" }],
    invitations: [invitation],
    create: { allowed: true, reason: null },
    reach: "live",
    heardAt: 1,
    error: null,
  };
  mock.select.mockResolvedValue(undefined);
  mock.call.mockImplementation(async (method) => {
    if (method === "spaces.status") return status;
    if (method === "spaces.invitation.accept") return { spaceId: "birch" };
    return {};
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function Fixture() {
  const actions = useReceivedInvitations(mock.select);
  return (
    <>
      <button onClick={() => actions.open(invitation)}>Birch Studio</button>
      <button onClick={() => void actions.respond(invitation, "decline")}>Decline from menu</button>
      <ReceivedInvitationDialog actions={actions} />
    </>
  );
}
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <Fixture />
    </QueryClientProvider>,
  );
}
const joins = () => mock.call.mock.calls.filter(([method]) => method === "spaces.invitation.accept");

it("opening detail does not accept, displays the fixed recipient and joins only on explicit submit", async () => {
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  await screen.findByRole("dialog", { name: "Join Birch Studio" });
  expect(joins()).toHaveLength(0);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("mira@example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Join Birch Studio" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(joins()).toEqual([["spaces.invitation.accept", { invitationId: "invite" }]]);
  expect(mock.select).toHaveBeenCalledWith("birch", expect.any(AbortSignal));
});
it("declining from detail confirms quietly while declining from the menu only removes the invitation", async () => {
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
  await screen.findByRole("dialog", { name: "Invitation declined" });
  expect(screen.getByText("You haven't joined Birch Studio.")).toBeTruthy();
  expect(mock.select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByText("Decline from menu"));
  await waitFor(() => expect(mock.call.mock.calls.filter(([method]) => method === "spaces.invitation.decline")).toHaveLength(2));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("keeps a race refusal in the detail without claiming membership", async () => {
  mock.call.mockImplementation(async (method) => {
    if (method === "spaces.status") return status;
    throw Error("This invitation is no longer available.");
  });
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  fireEvent.click(await screen.findByRole("button", { name: "Join Birch Studio" }));
  await screen.findByText("This invitation is no longer available.");
  expect(screen.queryByText("You joined Birch Studio.")).toBeNull();
  expect(mock.select).not.toHaveBeenCalled();
});
it("keeps a successful join and retries opening without accepting a second time", async () => {
  mock.select.mockRejectedValueOnce(Error("OpenOrc Cloud can't be reached."));
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  fireEvent.click(await screen.findByRole("button", { name: "Join Birch Studio" }));
  await screen.findByText("You joined Birch Studio.");
  expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Birch Studio" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(joins()).toHaveLength(1);
  expect(mock.select).toHaveBeenCalledTimes(2);
});
it.each([false, true])("a later successful read opens only while the joined detail remains open: closed=%s", async (closed) => {
  mock.select.mockRejectedValueOnce(Error("OpenOrc Cloud can't be reached."));
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  fireEvent.click(await screen.findByRole("button", { name: "Join Birch Studio" }));
  await screen.findByText("You joined Birch Studio.");
  if (closed) fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {
    queryClient.setQueryData(["spaces.status", {}], {
      ...status,
      heardAt: 2,
      invitations: [],
      spaces: [...status.spaces, { id: "birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member", role: "member", memberCount: 2 }],
    });
  });
  await waitFor(() => expect(mock.select).toHaveBeenCalledTimes(closed ? 1 : 2));
  expect(joins()).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("closing while Join waits prevents later navigation without undoing the membership", async () => {
  let resolve: ((value: { spaceId: string }) => void) | undefined;
  mock.call.mockImplementation(async (method) =>
    method === "spaces.status"
      ? status
      : new Promise((done) => {
          resolve = done;
        }),
  );
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  fireEvent.click(await screen.findByRole("button", { name: "Join Birch Studio" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => resolve!({ spaceId: "birch" }));
  expect(mock.select).not.toHaveBeenCalled();
  expect(joins()).toHaveLength(1);
});

it("updates the inviter's face and name in an already open detail", async () => {
  show();
  fireEvent.click(screen.getByText("Birch Studio"));
  await screen.findByRole("dialog");
  const image = "data:image/webp;base64,UklGRg==";
  await act(async () => {
    queryClient.setQueryData(["spaces.status", {}], { ...status, invitations: [{ ...invitation, inviter: { ...invitation.inviter, name: "Alex Lee", image } }] });
  });
  expect(screen.getByText("Alex Lee invited you.")).toBeTruthy();
  expect(document.querySelector(".organization-received-person img")?.getAttribute("src")).toBe(image);
});

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationInvitation } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { OrganizationInvitations } from "./OrganizationInvitations";

const mock = vi.hoisted(() => ({ call: vi.fn(), copy: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
let rows: OrganizationInvitation[];
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  queryClient.setQueryDefaults(["organization.invitations"], { retry: false });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mock.copy.mockResolvedValue(undefined) } });
  rows = [
    {
      id: "invite",
      email: "mira@example.com",
      role: "member",
      expiresAt: Date.now() + 86_400_000,
      state: "pending",
      url: "https://web.example.com/invite/server-link",
      delivery: { status: "sent", reason: null, at: Date.now() - 120000 },
      resendAt: Date.now() + 480000,
    },
  ];
  mock.call.mockImplementation(async (method) => {
    if (method === "organization.invitations") return [...rows];
    if (method === "organization.invitation.revoke") {
      rows = [];
      return {};
    }
    return rows[0];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});
function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationInvitations spaceId="birch" />
    </QueryClientProvider>,
  );
}

it("shows delivery time, disables a cooling resend and copies exactly the server's URL", async () => {
  show();
  await screen.findByText("mira@example.com");
  expect(screen.getByText("Member · Sent 2 minutes ago")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Resend" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "More for invitation to mira@example.com" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(mock.copy).toHaveBeenCalledExactlyOnceWith("https://web.example.com/invite/server-link");
});

it("keeps failed delivery copyable and offers an explicit resend without pretending it was sent", async () => {
  rows[0]!.delivery = { status: "failed", reason: "The mail service refused this address.", at: Date.now() };
  rows[0]!.resendAt = 0;
  show();
  await screen.findByText("Email wasn't sent");
  expect(screen.getByText("The mail service refused this address.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByRole("button", { name: "Copied" });
  fireEvent.click(screen.getByRole("button", { name: "More for invitation to mira@example.com" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Resend" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.invitation.resend", { spaceId: "birch", invitationId: "invite" }));
});

it("confirms a revoke and removes the whole section when no invitations remain", async () => {
  show();
  await screen.findByText("mira@example.com");
  fireEvent.click(screen.getByRole("button", { name: "More for invitation to mira@example.com" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke invitation…" }));
  await screen.findByRole("dialog", { name: "Revoke invitation?" });
  fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Invitations" })).toBeNull());
  expect(mock.call).toHaveBeenCalledWith("organization.invitation.revoke", { spaceId: "birch", invitationId: "invite" });
});

it("does not turn a failed list read into an empty invitation section", async () => {
  mock.call.mockRejectedValue(new Error("OpenOrc Cloud can't be reached."));
  show();
  await screen.findByText("OpenOrc Cloud can't be reached.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("updates the expiry and resend deadline without a server event", async () => {
  rows[0]!.expiresAt = Date.now() + 500;
  rows[0]!.resendAt = Date.now() + 500;
  queryClient.setQueryData(["organization.invitations", { spaceId: "birch" }], rows);
  vi.useFakeTimers();
  show();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText("Member · Expired")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Resend" }).disabled).toBe(false);
});

it("says an invitation includes Pro only while the server says it holds a paid seat", async () => {
  rows = [{ ...rows[0]!, includesSeat: true }];
  const shown = show();
  expect(await screen.findByText("Member · Sent 2 minutes ago · Includes Pro")).toBeTruthy();
  rows = [{ ...rows[0]!, includesSeat: false }];
  await act(() => queryClient.invalidateQueries({ queryKey: ["organization.invitations"] }));
  expect(await screen.findByText("Member · Sent 2 minutes ago")).toBeTruthy();
  shown.unmount();
});

it("promises nothing for an expired invitation, whatever an old answer said", async () => {
  rows = [{ ...rows[0]!, state: "expired", expiresAt: Date.now() - 1000, includesSeat: true }];
  show();
  expect(await screen.findByText("Member · Expired")).toBeTruthy();
  expect(screen.queryByText(/Includes Pro/)).toBeNull();
});

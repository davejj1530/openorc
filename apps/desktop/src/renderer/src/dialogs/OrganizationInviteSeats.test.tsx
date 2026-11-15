import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationInviteResult, OrganizationSeat } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import type { InvitationSeatInventory } from "../lib/invitation-seat-inventory";
import { OrganizationInviteDialog } from "./OrganizationInviteDialog";

const mock = vi.hoisted(() => ({
  call: vi.fn(),
  send: vi.fn<(email: string, seatId: string | undefined) => Promise<unknown>>(),
  inventory: null as unknown,
}));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/invitation-seat-inventory", () => ({ useInvitationSeatInventory: () => mock.inventory }));

const organization = { id: "birch", name: "Birch Studio", logo: null };
const close = vi.fn();
const buy = vi.fn();
const NO_SEATS = "There are no available seats. Buy another seat or take one back first.";
const NEEDS_SEAT = "Each invitation needs a seat while your account is frozen.";
const seat = (id: string, hours: number): OrganizationSeat => ({
  id,
  assignment: { kind: "available" },
  period: { startsAt: 1, endsAt: 2 },
  included: { grantedSeconds: 360_000, usedSeconds: 360_000 - hours * 3600, leftSeconds: hours * 3600 },
  retiresAt: null,
});
const inventory = (seats: OrganizationSeat[], frozen = false): InvitationSeatInventory => ({ seats, frozen });
function sent(email: string, includesSeat?: boolean): Extract<OrganizationInviteResult, { state: "sent" }> {
  const invitation = {
    id: email,
    email,
    role: "member" as const,
    expiresAt: 1000,
    state: "pending" as const,
    url: "https://app.example.com/invite/one",
    delivery: { status: "sent" as const, reason: null, at: 1 },
    resendAt: 600001,
  };
  return { email, state: "sent", invitationId: email, error: null, invitation: { ...invitation, ...(includesSeat !== undefined && { includesSeat }) } };
}
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  mock.inventory = inventory([seat("small", 12), seat("full", 100), seat("half", 50)]);
  mock.send.mockImplementation(async (email, seatId) => sent(email, seatId !== undefined));
  mock.call.mockImplementation(async (method: string, params: { emails: string[]; seats?: Record<string, string> }) => {
    if (method === "organization.people") return { viewer: { role: "admin" } };
    if (method === "organization.invite") return [await mock.send(params.emails[0]!, params.seats?.[params.emails[0]!])];
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
const show = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <OrganizationInviteDialog organization={organization} onClose={close} onViewInvitations={() => {}} onBuySeats={buy} />
    </QueryClientProvider>,
  );
const type = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "Email addresses" }), { target: { value } });
const seatOf = (email: string) => screen.getByRole<HTMLInputElement>("switch", { name: `Seat for ${email}` });
const sendButton = (name = "Send invitations") => screen.getByRole<HTMLButtonElement>("button", { name });
async function submit(name = "Send invitations") {
  await waitFor(() => expect(sendButton(name).disabled).toBe(false));
  fireEvent.click(sendButton(name));
}

it("offers no seat where the organization has none to hold", () => {
  mock.inventory = null;
  show();
  type("mara@example.com");
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText(/free seats/)).toBeNull();
});

it("gives each address a seat switch, off at first, and sends the fullest free seat with the address switched on", async () => {
  show();
  type("mara@example.com\nines@example.com");
  expect([seatOf("mara@example.com").checked, seatOf("ines@example.com").checked]).toEqual([false, false]);
  expect(screen.getByText("0 of 3 free seats")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Buy seats" })).toBeNull();
  fireEvent.click(seatOf("ines@example.com"));
  expect(screen.getByText("1 of 3 free seats")).toBeTruthy();
  await submit();
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send.mock.calls).toEqual([
    ["mara@example.com", undefined],
    ["ines@example.com", "full"],
  ]);
  expect(within(screen.getByText("ines@example.com").parentElement!).getByText("Sent · Includes Pro")).toBeTruthy();
  expect(within(screen.getByText("mara@example.com").parentElement!).getByText("Sent")).toBeTruthy();
});

it("holds further switches once the free seats are taken, says why on demand, and lets a choice be given back", () => {
  mock.inventory = inventory([seat("a", 10), seat("b", 20)]);
  show();
  type("mara@example.com\nines@example.com\nstudio@example.com");
  fireEvent.click(seatOf("mara@example.com"));
  fireEvent.click(seatOf("ines@example.com"));
  expect(screen.getByText("2 of 2 free seats")).toBeTruthy();
  expect(seatOf("studio@example.com").disabled).toBe(true);
  expect(seatOf("studio@example.com").closest("[data-tip]")?.getAttribute("data-tip")).toBe(NO_SEATS);
  expect(seatOf("mara@example.com").disabled).toBe(false);
  expect(screen.getByRole("button", { name: "Buy seats" })).toBeTruthy();
  fireEvent.click(seatOf("mara@example.com"));
  expect(screen.getByText("1 of 2 free seats")).toBeTruthy();
  expect(seatOf("studio@example.com").disabled).toBe(false);
});

it("says there are no free seats and still sends without one", async () => {
  mock.inventory = inventory([]);
  show();
  type("mara@example.com");
  expect(screen.getByText("0 free seats")).toBeTruthy();
  expect(seatOf("mara@example.com").disabled).toBe(true);
  await submit();
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send.mock.calls).toEqual([["mara@example.com", undefined]]);
});

it("keeps the unsent draft through Buy seats and shows it again", () => {
  mock.inventory = inventory([seat("a", 10)]);
  const first = show();
  type("mara@example.com\nines@example.com");
  fireEvent.click(seatOf("ines@example.com"));
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  expect(buy).toHaveBeenCalledOnce();
  first.unmount();
  show();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Email addresses" }).value).toBe("mara@example.com\nines@example.com");
  expect([seatOf("mara@example.com").checked, seatOf("ines@example.com").checked]).toEqual([false, true]);
});

it("forgets a draft that was cancelled", () => {
  const first = show();
  type("mara@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  first.unmount();
  show();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Email addresses" }).value).toBe("");
});

it("gives a frozen admin's addresses a seat from the start, and sends none without one, with the reason on demand", async () => {
  mock.inventory = inventory([seat("a", 10), seat("b", 20)], true);
  show();
  type("mara@example.com\nines@example.com");
  expect([seatOf("mara@example.com").checked, seatOf("ines@example.com").checked]).toEqual([true, true]);
  expect(screen.queryByText(NEEDS_SEAT)).toBeNull();
  fireEvent.click(seatOf("ines@example.com"));
  expect(sendButton().disabled).toBe(true);
  expect(sendButton().getAttribute("data-tip")).toBe(NEEDS_SEAT);
  fireEvent.click(seatOf("ines@example.com"));
  await submit();
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send.mock.calls).toEqual([
    ["mara@example.com", "b"],
    ["ines@example.com", "a"],
  ]);
});

it("holds a frozen admin's send while there is no seat for every address", () => {
  mock.inventory = inventory([seat("a", 10)], true);
  show();
  type("mara@example.com\nines@example.com");
  expect([seatOf("mara@example.com").checked, seatOf("ines@example.com").checked]).toEqual([true, false]);
  expect(sendButton().disabled).toBe(true);
  expect(sendButton().getAttribute("data-tip")).toBe(NEEDS_SEAT);
  expect(screen.getByRole("button", { name: "Buy seats" })).toBeTruthy();
});

it("keeps what was sent, and picks a free seat again for the address whose seat was just taken", async () => {
  mock.inventory = inventory([seat("a", 10), seat("b", 20), seat("c", 30)]);
  mock.send.mockImplementation(async (email, seatId) =>
    seatId === "b" ? { email, state: "refused", error: "That seat was just taken. Send the invitation again." } : sent(email, seatId !== undefined),
  );
  const shown = show();
  type("mara@example.com\nines@example.com");
  fireEvent.click(seatOf("mara@example.com"));
  fireEvent.click(seatOf("ines@example.com"));
  await submit();
  await screen.findByText("That seat was just taken. Send the invitation again.");
  expect(screen.getByText("Sent · Includes Pro")).toBeTruthy();
  mock.inventory = inventory([seat("a", 10)]);
  shown.rerender(
    <QueryClientProvider client={queryClient}>
      <OrganizationInviteDialog organization={organization} onClose={close} onViewInvitations={() => {}} onBuySeats={buy} />
    </QueryClientProvider>,
  );
  await submit("Try again");
  await screen.findByRole("dialog", { name: "Invitations sent" });
  expect(mock.send.mock.calls).toEqual([
    ["mara@example.com", "c"],
    ["ines@example.com", "b"],
    ["ines@example.com", "a"],
  ]);
});

it("says so when a seat was asked for and the invitation holds none", async () => {
  mock.send.mockImplementation(async (email) => sent(email));
  show();
  type("mara@example.com");
  fireEvent.click(seatOf("mara@example.com"));
  await submit();
  await screen.findByRole("dialog", { name: "Invitations" });
  expect(screen.getByText("The seat wasn't held for this invitation.")).toBeTruthy();
  expect(screen.queryByText(/Includes Pro/)).toBeNull();
});

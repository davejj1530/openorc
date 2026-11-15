import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OrganizationBilling, SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork } from "@openorc/protocol";
import { accountDay } from "@openorc/client";
import { afterEach, expect, it, vi } from "vitest";
import { SeatQuantity } from "../lib/seat-quantity";
import { ChangeSeatsDialog } from "./ChangeSeatsDialog";

const ID = "6b556141-a9de-41be-a557-aa938a09b8b8";
const RENEWS = Date.UTC(2026, 11, 1, 6, 5);
const DAY = accountDay(RENEWS);
const PAYMENT = "The payment for these seats didn't go through. Update the payment method in billing and try again.";
const STALE = "The seats have changed. Review the change again.";
const person = { id: "u", name: "Mara Okafor", email: "mara@example.com", image: null };
function billing(standing: "live" | "ending" = "live", pending: number | null = null): OrganizationBilling {
  const seat = (id: string, held: boolean) => ({
    id,
    assignment: held ? { kind: "member" as const, memberId: id, person, paysForPro: false } : { kind: "available" as const },
    period: { startsAt: 1, endsAt: RENEWS },
    included: { grantedSeconds: 360_000, usedSeconds: 0, leftSeconds: 360_000 },
    retiresAt: null,
  });
  return {
    organization: { id: "birch", name: "Altalogy", logo: null },
    revision: "r1",
    asOf: 1,
    subscription: {
      id: "s",
      plan: "monthly",
      standing,
      paidUntil: RENEWS,
      graceUntil: null,
      quantity: 5,
      overallocated: false,
      pendingQuantity: pending === null ? null : { quantity: pending, at: RENEWS },
    },
    seats: [seat("a", true), seat("b", true), seat("c", true), seat("d", false), seat("e", false)],
    available: 2,
  };
}
const review = (to: number, extra: Partial<SeatQuantityPreview> = {}): SeatQuantityPreview => ({
  token: `token-${to}`,
  expiresAt: Date.now() + 60_000,
  asOf: Date.now(),
  from: 5,
  to,
  effect: to >= 5 ? "now" : "renewal",
  at: to >= 5 ? Date.now() : RENEWS,
  nextPrice: { amount: to * 2000, currency: "usd" },
  estimatedChargeNow: to > 5 ? { amount: 2133, currency: "usd" } : null,
  firstGrantSecondsPerNewSeat: to > 5 ? 192_000 : 0,
  firstGrantEndsAt: to > 5 ? RENEWS : null,
  ...extra,
});
const done = (request: SeatQuantityRequest, state: "complete" | "pending" | "failed" = "complete", message: string | null = null, error: string | null = null): SeatQuantityWork => ({
  request,
  operation: { id: request.body.id, kind: "quantity", state, message },
  error,
});
afterEach(cleanup);

function show(
  options: {
    preview?: (seats: number) => Promise<SeatQuantityPreview>;
    send?: (request: SeatQuantityRequest) => Promise<SeatQuantityWork>;
    read?: (id: string) => Promise<SeatQuantityWork | null>;
    billing?: OrganizationBilling;
    keep?: boolean;
  } = {},
) {
  const preview = vi.fn(options.preview ?? (async (seats: number) => review(seats)));
  const send = vi.fn(options.send ?? (async (request: SeatQuantityRequest) => done(request)));
  const read = vi.fn(options.read ?? (async () => null));
  const view = new SeatQuantity({ current: () => true, now: Date.now, id: () => ID, preview, send, read });
  const close = vi.fn();
  const manage = vi.fn();
  const current = options.billing ?? billing();
  if (options.keep) {
    view.select(current.subscription!.quantity);
    void view.review();
  }
  render(<ChangeSeatsDialog view={view} billing={current} onClose={close} onManageBilling={manage} />);
  return { view, preview, send, read, close, manage };
}
const field = () => screen.getByRole<HTMLInputElement>("spinbutton", { name: "Seats" });
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
const fact = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

it("starts at the number of seats now, and reviews only another number from 0 to 100", () => {
  show();
  expect(field().value).toBe("5");
  expect(screen.getByText("5 seats now · 3 assigned")).toBeTruthy();
  expect(button("Review change").disabled).toBe(true);
  type("101");
  expect(screen.getByText("Choose a number of seats from 0 to 100.")).toBeTruthy();
  expect(button("Review change").disabled).toBe(true);
  type("7");
  expect(screen.queryByText("Choose a number of seats from 0 to 100.")).toBeNull();
  expect(button("Review change").disabled).toBe(false);
});

it("shows more seats with the charge and hours as estimates, and adds them on Add seats", async () => {
  const { send, close } = show();
  type("7");
  fireEvent.click(button("Review change"));
  await screen.findByRole("dialog", { name: "Add 2 seats" });
  expect([fact("Seats"), fact("Available"), fact("Next price"), fact("Estimated charge now"), fact("Estimated hours per new seat")]).toEqual([
    "5 → 7",
    "After payment",
    "$140 a month",
    "$21.33",
    `53 h 20 min until ${DAY}`,
  ]);
  fireEvent.click(button("Add seats"));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledExactlyOnceWith({ seats: 7, body: { id: ID, previewToken: "token-7" } });
});

it("shows no charge where the server sends none, and never a made-up price", async () => {
  show({ preview: async (seats) => review(seats, { estimatedChargeNow: null, nextPrice: null }) });
  type("7");
  fireEvent.click(button("Review change"));
  await screen.findByRole("dialog", { name: "Add 2 seats" });
  expect(screen.queryByText("Estimated charge now")).toBeNull();
  expect(fact("Next price")).toBe("Price unavailable");
});

it("says a reduction waits for renewal and whose seats stay", async () => {
  show();
  type("4");
  fireEvent.click(button("Review change"));
  await screen.findByRole("dialog", { name: "Reduce to 4 seats" });
  expect([fact("Seats"), fact("Takes effect"), fact("Next price")]).toEqual(["5 → 4", DAY, "$80 a month"]);
  expect(screen.queryByText(/Estimated/)).toBeNull();
  expect(screen.getByText("1 available seat ends. People and invitations holding seats keep theirs.")).toBeTruthy();
  expect(button("Reduce seats")).toBeTruthy();
});

it("says what ending the subscription does to the people who hold seats", async () => {
  show();
  type("0");
  fireEvent.click(button("Review change"));
  await screen.findByRole("dialog", { name: "End Altalogy’s subscription" });
  expect([fact("Seats"), fact("Takes effect"), fact("Next price")]).toEqual([`5 until ${DAY}`, DAY, "No renewal"]);
  expect(screen.getByText(`People keep these seats until ${DAY}. Those without other Pro then have one day of grace.`)).toBeTruthy();
  expect(button("End subscription")).toBeTruthy();
});

it("opens Keep current seats on the server's review of the same number", async () => {
  show({ keep: true, billing: billing("ending", 0) });
  await screen.findByRole("dialog", { name: "Keep 5 seats" });
  expect([fact("Seats"), fact("Takes effect"), fact("Next price")]).toEqual(["5", "Now", "$100 a month"]);
  expect(screen.getByText(`All 5 seats renew on ${DAY}.`)).toBeTruthy();
  expect(button("Keep current seats")).toBeTruthy();
});

it("puts a refused review under the number, and reviews again", async () => {
  let refuse = true;
  const { preview } = show({
    preview: async (seats) => {
      if (refuse) throw new Error("Take back seats or revoke their invitations before reducing the number of seats.");
      return review(seats);
    },
  });
  type("2");
  fireEvent.click(button("Review change"));
  expect((await screen.findByRole("alert")).textContent).toBe("Take back seats or revoke their invitations before reducing the number of seats.");
  expect(field().value).toBe("2");
  refuse = false;
  fireEvent.click(button("Review again"));
  await screen.findByRole("dialog", { name: "Reduce to 2 seats" });
  expect(preview).toHaveBeenCalledTimes(2);
});

it("keeps a refused payment beside its review and offers the organization's billing, not the change again", async () => {
  const { manage, send } = show({ send: async (request) => done(request, "failed", PAYMENT) });
  type("7");
  fireEvent.click(button("Review change"));
  fireEvent.click(await screen.findByRole("button", { name: "Add seats" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PAYMENT);
  expect(screen.getByRole("dialog", { name: "Add 2 seats" })).toBeTruthy();
  expect(fact("Seats")).toBe("5 → 7");
  expect(screen.queryByRole("button", { name: "Add seats" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review again" })).toBeNull();
  expect(button("Cancel")).toBeTruthy();
  fireEvent.click(button("Manage billing"));
  expect(manage).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});

it("says Updating seats while the server settles the change, and Close leaves it running", async () => {
  const { close, send } = show({ send: async (request) => done(request, "pending", "Updating seats.") });
  type("7");
  fireEvent.click(button("Review change"));
  fireEvent.click(await screen.findByRole("button", { name: "Add seats" }));
  await screen.findByRole("dialog", { name: "Updating seats" });
  expect(screen.getByRole("status").textContent).toBe("Updating seats.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByText("Close"));
  expect(close).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});

it("closes once the seats are updated, even when only the read after it failed", async () => {
  const { send, read, close } = show({ send: async (request) => done(request, "complete", null, "OpenOrc Cloud can't be reached.") });
  type("7");
  fireEvent.click(button("Review change"));
  fireEvent.click(await screen.findByRole("button", { name: "Add seats" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(send).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});

it("reviews again after a change the server refused as stale, with the server's words", async () => {
  let stale = true;
  const { preview, send } = show({ send: async (request) => (stale ? done(request, "failed", STALE) : done(request)) });
  type("7");
  fireEvent.click(button("Review change"));
  fireEvent.click(await screen.findByRole("button", { name: "Add seats" }));
  expect((await screen.findByRole("alert")).textContent).toBe(STALE);
  expect(screen.getByRole("dialog", { name: "Add 2 seats" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
  stale = false;
  fireEvent.click(button("Review again"));
  await screen.findByRole("button", { name: "Add seats" });
  expect(preview).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledOnce();
});

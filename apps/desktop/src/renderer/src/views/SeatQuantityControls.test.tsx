import type { OrganizationBilling, OrganizationBillingStatus, SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork } from "@openorc/protocol";
import { accountDay } from "@openorc/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrganizationBillingView } from "../lib/organization-billing-state";
import { SeatQuantity } from "../lib/seat-quantity";
import type { SeatQuantityTransport } from "../lib/seat-quantity-scope";
import { OrganizationSeats } from "./OrganizationSeats";

// The real hook hands back one flow for as long as the dialog is open; so does this stand-in.
const flow = vi.hoisted(() => ({ make: null as null | (() => unknown), open: null as unknown }));
vi.mock("../lib/seat-quantity-scope", async () => {
  const { useEffect } = await import("react");
  return {
    useSeatQuantity: () => {
      useEffect(() => () => void (flow.open = null), []);
      return (flow.open ??= flow.make?.() ?? null);
    },
  };
});

const ID = "6b556141-a9de-41be-a557-aa938a09b8b8";
const RENEWS = Date.UTC(2026, 11, 1, 6, 5);
const DAY = accountDay(RENEWS);
const PAYMENT = "The payment for these seats didn't go through. Update the payment method in billing and try again.";
function billing(standing: "live" | "ending" | "ended" = "live", pending: number | null = null): OrganizationBilling {
  return {
    organization: { id: "team-a", name: "Altalogy", logo: null },
    revision: "1",
    asOf: 1000,
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
    seats: [],
    available: 2,
  };
}
const request: SeatQuantityRequest = { seats: 7, body: { id: ID, previewToken: "token-7" } };
const work = (state: "pending" | "complete" | "failed" | null, message: string | null = null, error: string | null = null, code: string | null = null): SeatQuantityWork => ({
  request,
  operation: state && { id: ID, kind: "quantity", state, message, code },
  error,
});
const review = (to: number): SeatQuantityPreview => ({
  token: `token-${to}`,
  expiresAt: Date.now() + 60_000,
  asOf: Date.now(),
  from: 5,
  to,
  effect: "now",
  at: Date.now(),
  nextPrice: { amount: to * 2000, currency: "usd" },
  estimatedChargeNow: null,
  firstGrantSecondsPerNewSeat: 0,
  firstGrantEndsAt: null,
});

const views: OrganizationBillingView[] = [];
let transport: SeatQuantityTransport & { preview: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; operation: ReturnType<typeof vi.fn> };
beforeEach(() => {
  transport = {
    preview: vi.fn(async (_spaceId: string, seats: number) => review(seats)),
    confirm: vi.fn(async (_spaceId: string, sent: SeatQuantityRequest) => ({
      request: sent,
      operation: { id: sent.body.id, kind: "quantity" as const, state: "complete" as const, message: null },
      error: null,
    })),
    operation: vi.fn(async () => work("complete")),
    subscribe: () => () => {},
  };
  flow.make = () =>
    new SeatQuantity({
      current: () => true,
      now: Date.now,
      id: () => ID,
      preview: (seats) => transport.preview("team-a", seats),
      send: (sent) => transport.confirm("team-a", sent),
      read: (id) => transport.operation("team-a", id),
    });
});
afterEach(() => {
  cleanup();
  flow.open = null;
  views.splice(0).forEach((view) => view.close());
});
async function show(status: Partial<OrganizationBillingStatus> & { billing: OrganizationBilling }) {
  const full: OrganizationBillingStatus = { payment: null, error: null, ...status };
  const open = vi.fn(async () => full);
  const view = new OrganizationBillingView({ current: () => true, get: async () => full, open, leave: async () => full });
  views.push(view);
  await view.refresh();
  render(<OrganizationSeats spaceId="team-a" view={view} offers={async () => ({ offers: [], monthlySeconds: 360000, maxSeats: 100 })} quantity={transport} />);
  return { view, open };
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

it("offers Change seats as the one ink key once seats are bought, and opens on the number now", async () => {
  await show({ billing: billing() });
  expect(screen.queryByRole("button", { name: "Buy seats" })).toBeNull();
  fireEvent.click(button("Change seats"));
  await screen.findByRole("dialog", { name: "Change seats" });
  expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Seats" }).value).toBe("5");
});

it("offers no Change seats where there are no seats, or they have ended", async () => {
  await show({ billing: { ...billing(), subscription: null } });
  expect(screen.queryByRole("button", { name: "Change seats" })).toBeNull();
  cleanup();
  await show({ billing: billing("ended") });
  expect(screen.queryByRole("button", { name: "Change seats" })).toBeNull();
});

it("says Updating seats while a change is being settled, holds Change seats with that reason, and opens the change", async () => {
  await show({ billing: billing(), quantity: [work("pending", "Updating seats.")] });
  expect(button("Change seats").disabled).toBe(true);
  expect(button("Change seats").closest("[data-tip]")?.getAttribute("data-tip") ?? button("Change seats").getAttribute("data-tip")).toBe("Updating seats.");
  fireEvent.click(button("View seat change"));
  await screen.findByRole("dialog", { name: "Updating seats" });
});

it("keeps a refused payment on the page with the organization's billing, and still lets the number be changed", async () => {
  const { open } = await show({ billing: billing(), quantity: [work("failed", PAYMENT, null, "payment_refused")] });
  expect(screen.getByRole("alert").textContent).toBe(PAYMENT);
  expect(button("Change seats").disabled).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "Manage billing" }).at(-1)!);
  expect(open).toHaveBeenCalledExactlyOnceWith({ page: "billing" });
});

it("offers the change again, not billing, for a change the server refused for another reason", async () => {
  const STALE = "The seats have changed. Review the change again.";
  await show({ billing: billing(), quantity: [work("failed", STALE, null, "not_changed")] });
  expect(screen.getByRole("alert").textContent).toBe(STALE);
  expect(screen.getAllByRole("button", { name: "Manage billing" })).toHaveLength(1);
  fireEvent.click(button("Review again"));
  await screen.findByRole("dialog", { name: "Add 2 seats" });
  expect(transport.preview).toHaveBeenCalledExactlyOnceWith("team-a", 7);
  expect(transport.confirm).not.toHaveBeenCalled();
});

it("says once that the seats were updated when only the read after failed, and Try again only reads", async () => {
  await show({ billing: billing(), quantity: [work("complete", null, "OpenOrc Cloud can't be reached.")], error: "OpenOrc Cloud can't be reached." });
  expect(screen.getByText("Seats updated.")).toBeTruthy();
  expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(["OpenOrc Cloud can't be reached."]);
  fireEvent.click(button("Try again"));
  await waitFor(() => expect(transport.operation).toHaveBeenCalledExactlyOnceWith("team-a", ID));
  expect(transport.confirm).not.toHaveBeenCalled();
});

it("names a scheduled reduction with its date, and Keep current seats asks the server to review the number now", async () => {
  await show({ billing: billing("live", 4) });
  expect(screen.getByText(`4 seats from ${DAY}.`)).toBeTruthy();
  fireEvent.click(button("Keep current seats"));
  await screen.findByRole("dialog", { name: "Keep 5 seats" });
  expect(transport.preview).toHaveBeenCalledExactlyOnceWith("team-a", 5);
  fireEvent.click(screen.getAllByRole("button", { name: "Keep current seats" }).at(-1)!);
  await waitFor(() => expect(transport.confirm).toHaveBeenCalledExactlyOnceWith("team-a", { seats: 5, body: { id: ID, previewToken: "token-5" } }));
});

it("names seats that are ending with their date", async () => {
  await show({ billing: billing("ending", 0) });
  expect(screen.getByText(`All 5 seats end on ${DAY}.`)).toBeTruthy();
  expect(button("Keep current seats")).toBeTruthy();
});

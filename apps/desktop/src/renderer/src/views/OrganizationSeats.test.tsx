import type { OrganizationBillingOffers, OrganizationBillingPage, OrganizationBillingStatus } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationBillingView } from "../lib/organization-billing-state";
import { OrganizationSeats } from "./OrganizationSeats";

const target: OrganizationBillingPage = { page: "checkout", plan: "monthly", seats: 1 };
const empty: OrganizationBillingStatus = {
  billing: { organization: { id: "team-a", name: "Example team", logo: null }, revision: "1", asOf: 1000, subscription: null, seats: [], available: 0 },
  payment: null,
  error: null,
};
const waiting: OrganizationBillingStatus = { ...empty, payment: { id: "request-a", target, state: "waiting", since: 1000, watching: true, error: null } };
const views: OrganizationBillingView[] = [];
afterEach(() => {
  cleanup();
  views.splice(0).forEach((view) => view.close());
});

async function show(status = empty) {
  const get = vi.fn(async () => status);
  const open = vi.fn(async (_target: OrganizationBillingPage) => waiting);
  const leave = vi.fn(async () => ({ ...waiting, payment: waiting.payment && { ...waiting.payment, watching: false } }));
  const view = new OrganizationBillingView({ current: () => true, get, open, leave });
  views.push(view);
  await view.refresh();
  const offers = vi.fn(async (_spaceId: string, seats: number): Promise<OrganizationBillingOffers> => ({
    offers: [
      { plan: "monthly", seats, price: { amount: 1937, currency: "usd" } },
      { plan: "yearly", seats, price: null },
    ],
    monthlySeconds: 360000,
    maxSeats: 100,
  }));
  render(<OrganizationSeats spaceId="team-a" view={view} offers={offers} />);
  return { view, get, open, leave, offers };
}

it("keeps the draft and refusal in the purchase dialog when checkout cannot be created", async () => {
  const f = await show();
  f.open.mockResolvedValueOnce({ ...waiting, payment: waiting.payment && { ...waiting.payment, state: "failed", watching: false, error: "Seat payments are not configured." } });
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Seats" }), { target: { value: "3" } });
  await screen.findByText(/19.37 a month/);
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await waitFor(() => expect(f.open).toHaveBeenCalled());
  expect(screen.getByRole("dialog").textContent).toContain("Seat payments are not configured.");
  expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Seats" }).value).toBe("3");
});
it("keeps an unconfirmed return waiting and stops only the temporary watch", async () => {
  const f = await show(waiting);
  expect(screen.getByText("Waiting for your payment")).toBeTruthy();
  await act(() => f.view.refresh());
  expect(screen.getByText("Waiting for your payment")).toBeTruthy();
  expect(f.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
  await waitFor(() => expect(screen.queryByText("Waiting for your payment")).toBeNull());
  expect(screen.getByText("No seats")).toBeTruthy();
  expect(screen.queryByText(/cancelled|failed/i)).toBeNull();
});
it("allows changed choices on a new press after stopping the payment watch", async () => {
  const f = await show({ ...waiting, payment: waiting.payment && { ...waiting.payment, watching: false } });
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  const count = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Seats" });
  expect(count.disabled).toBe(false);
  fireEvent.change(count, { target: { value: "2" } });
  await screen.findByText(/19.37 a month/);
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await waitFor(() => expect(f.open).toHaveBeenCalledExactlyOnceWith({ page: "checkout", plan: "monthly", seats: 2 }));
});
it("keeps an unresolved purchase draft and repeats its exact choices only on a press", async () => {
  const f = await show();
  const chosen = { page: "checkout", plan: "monthly", seats: 3 } as const;
  f.open.mockResolvedValueOnce({ ...waiting, payment: waiting.payment && { ...waiting.payment, target: chosen, state: "pending", error: "Polar didn't answer. Try again in a moment." } });
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Seats" }), { target: { value: "3" } });
  await screen.findByText(/19.37 a month/);
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Polar didn't answer."));
  expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Seats" })).toMatchObject({ value: "3", disabled: true });
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(f.open).toHaveBeenCalledExactlyOnceWith(chosen);
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
  expect(f.open).toHaveBeenLastCalledWith(chosen);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("reports a completed purchase after its read fails and retries only the read", async () => {
  const f = await show({ ...waiting, payment: waiting.payment && { ...waiting.payment, state: "complete", watching: false }, error: "Offline" });
  expect(screen.getByText("Seats bought.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Buy seats" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
  expect(f.open).not.toHaveBeenCalled();
});
it("closes a pending draft when a later billing read confirms payment", async () => {
  const f = await show();
  f.open.mockResolvedValueOnce({ ...waiting, payment: waiting.payment && { ...waiting.payment, state: "pending", error: "Payment is still being checked." } });
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await screen.findByText(/19.37 a month/);
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Payment is still being checked."));
  f.get.mockResolvedValueOnce({ ...waiting, payment: waiting.payment && { ...waiting.payment, state: "complete", watching: false }, error: "Offline" });
  await act(() => f.view.refresh());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Buy seats" })).toBeNull();
  expect(screen.queryByText("No seats")).toBeNull();
  expect(screen.getByText("Seats bought.")).toBeTruthy();
});
it("drops the inventory and an open purchase form on authority loss", async () => {
  const f = await show();
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  act(() => f.view.revoke());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("No seats")).toBeNull();
});
it("clears a priced purchase form on a core authority refusal before a roster update", async () => {
  const f = await show();
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  await screen.findByText(/19.37 a month/);
  f.get.mockResolvedValueOnce({ billing: null, payment: null, error: "Only an admin can do that." });
  await act(() => f.view.refresh());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("No seats")).toBeNull();
  expect(screen.queryByText(/19.37 a month/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Only an admin can do that.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.get).toHaveBeenCalledTimes(3));
  expect(f.open).not.toHaveBeenCalled();
});
it("retains an old holder without a membership and never invents unknown hours", async () => {
  const f = await show({
    ...empty,
    billing: empty.billing && {
      ...empty.billing,
      seats: [
        {
          id: "seat-a",
          assignment: { kind: "person", person: { id: "person-b", name: "Sam Example", email: "sam@example.com", image: null }, paysForPro: false },
          period: null,
          included: null,
          retiresAt: null,
        },
      ],
    },
  });
  expect(screen.getByText("Sam Example")).toBeTruthy();
  expect(screen.getByText("Not in this organization.")).toBeTruthy();
  expect(screen.getAllByText("Not available")).toHaveLength(2);
  expect(screen.queryByText("100 h")).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});

it("offers another purchase after the server confirms the previous subscription ended", async () => {
  await show({
    ...waiting,
    billing: empty.billing && {
      ...empty.billing,
      subscription: { id: "subscription-a", standing: "ended", plan: "monthly", paidUntil: 1000, graceUntil: null, quantity: 0, overallocated: false, pendingQuantity: null },
    },
    payment: waiting.payment && { ...waiting.payment, state: "complete", watching: false },
  });
  expect(screen.getByRole("button", { name: "Buy seats" }).hasAttribute("disabled")).toBe(false);
});

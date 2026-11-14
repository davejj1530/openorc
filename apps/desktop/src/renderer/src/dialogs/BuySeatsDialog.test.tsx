import type { OrganizationBillingOffers } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuySeatsDialog } from "./BuySeatsDialog";

afterEach(cleanup);
const quote = (seats: number, unknown = false): OrganizationBillingOffers => ({
  offers: [
    { plan: "monthly", seats, price: unknown ? null : { amount: 4577, currency: "usd" } },
    { plan: "yearly", seats, price: unknown ? null : { amount: 45001, currency: "usd" } },
  ],
  monthlySeconds: 360000,
  maxSeats: 100,
});
function show(offers = vi.fn(async (_spaceId: string, seats: number) => quote(seats))) {
  const onBuy = vi.fn(),
    onClose = vi.fn();
  render(<BuySeatsDialog spaceId="team-a" opening={false} offers={offers} onBuy={onBuy} onClose={onClose} />);
  return { offers, onBuy, onClose };
}

it("buys the chosen count and period using the exact returned total", async () => {
  const f = show();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Seats" }), { target: { value: "3" } });
  await screen.findByText(/450.01 a year/);
  fireEvent.click(screen.getByRole("radio", { name: /450.01 a year/ }));
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  expect(f.offers).toHaveBeenLastCalledWith("team-a", 3);
  expect(f.onBuy).toHaveBeenCalledExactlyOnceWith({ page: "checkout", seats: 3, plan: "yearly" });
  expect(screen.getByText("100 h per seat, each month")).toBeTruthy();
});
it("allows an unknown price without turning it into zero", async () => {
  const f = show(vi.fn(async (_spaceId: string, seats: number) => quote(seats, true)));
  expect(await screen.findByText("Price unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Buy seats" }));
  expect(f.onBuy).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/\$0/)).toBeNull();
});
it("discards old count quotes, blocks while loading and does not offer out-of-range purchases", async () => {
  let done: (value: OrganizationBillingOffers) => void = () => undefined;
  const f = show(
    vi.fn(
      () =>
        new Promise<OrganizationBillingOffers>((resolve) => {
          done = resolve;
        }),
    ),
  );
  const buy = screen.getByRole("button", { name: "Buy seats" });
  expect(buy.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Seats" }), { target: { value: "101" } });
  done(quote(1));
  await waitFor(() => expect(screen.getByText("Choose a number of seats from 1 to 100.")).toBeTruthy());
  expect(buy.hasAttribute("disabled")).toBe(true);
  fireEvent.click(buy);
  expect(f.onBuy).not.toHaveBeenCalled();
});
it("leaves a failed offer read actionable without opening a payment page", async () => {
  const offers = vi.fn<(spaceId: string, seats: number) => Promise<OrganizationBillingOffers>>().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(quote(1));
  const f = show(offers);
  expect(await screen.findByText("Offline")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText(/45.77 a month/);
  expect(f.onBuy).not.toHaveBeenCalled();
});

it("offers Close instead of implying a submitted purchase can be cancelled", () => {
  const onClose = vi.fn();
  render(<BuySeatsDialog spaceId="team-a" opening offers={async (_spaceId, seats) => quote(seats)} onBuy={vi.fn()} onClose={onClose} />);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: /^Close$/ }).at(-1)!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

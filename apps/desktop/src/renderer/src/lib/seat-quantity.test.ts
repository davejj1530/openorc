import type { SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { SeatQuantity, hoursAndMinutes, quantityChange } from "./seat-quantity";

const ID = "6b556141-a9de-41be-a557-aa938a09b8b8";
const review = (to: number, from = 5): SeatQuantityPreview => ({
  token: `token-${to}`,
  expiresAt: 61_000,
  asOf: 1000,
  from,
  to,
  effect: to > from ? "now" : "renewal",
  at: to > from ? 1000 : 9000,
  nextPrice: { amount: to * 2000, currency: "usd" },
  estimatedChargeNow: to > from ? { amount: 2133, currency: "usd" } : null,
  firstGrantSecondsPerNewSeat: to > from ? 192_000 : 0,
  firstGrantEndsAt: to > from ? 9000 : null,
});
function flow(preview: (seats: number) => Promise<SeatQuantityPreview> = async (seats) => review(seats)) {
  const send = vi.fn(async (request: SeatQuantityRequest): Promise<SeatQuantityWork> => ({
    request,
    operation: { id: request.body.id, kind: "quantity", state: "complete", message: null },
    error: null,
  }));
  const quantity = new SeatQuantity({ current: () => true, now: () => 1000, id: () => ID, preview, send, read: async () => null });
  return { quantity, send };
}

it("sends the reviewed number with the review's token under a fresh id", async () => {
  const { quantity, send } = flow();
  quantity.select(7);
  await quantity.review();
  expect(quantity.getSnapshot()).toMatchObject({ state: "preview", target: 7, preview: { from: 5, to: 7 } });
  await quantity.confirm();
  expect(send).toHaveBeenCalledExactlyOnceWith({ seats: 7, body: { id: ID, previewToken: "token-7" } });
  expect(quantity.getSnapshot().state).toBe("complete");
});

it("refuses a review of another number than the one asked, in the server's words", async () => {
  const { quantity, send } = flow(async () => review(6));
  quantity.select(7);
  await quantity.review();
  expect(quantity.getSnapshot()).toMatchObject({ state: "failed", preview: null, error: "The seats have changed. Review the change again." });
  await quantity.confirm();
  expect(send).not.toHaveBeenCalled();
});

it("drops a review when the number is edited", async () => {
  const { quantity } = flow();
  quantity.select(7);
  await quantity.review();
  quantity.select(8);
  expect(quantity.getSnapshot()).toMatchObject({ state: "draft", target: 8, preview: null });
});

it("shows a resumed change with its review only when that review is the one it was sent with", () => {
  const work: SeatQuantityWork = { request: { seats: 7, body: { id: ID, previewToken: "token-7" } }, operation: null, error: null };
  const same = flow().quantity;
  same.resume(work, review(7));
  expect(same.getSnapshot()).toMatchObject({ state: "pending", target: 7, preview: { to: 7 } });
  const other = flow().quantity;
  other.resume(work, review(8));
  expect(other.getSnapshot()).toMatchObject({ state: "pending", target: null, preview: null });
});

it("names what a review does", () => {
  expect(quantityChange(review(7))).toBe("add");
  expect(quantityChange(review(4))).toBe("reduce");
  expect(quantityChange(review(0))).toBe("end");
  expect(quantityChange(review(5))).toBe("keep");
});

it("writes a part month of hours down to the minute", () => {
  expect(hoursAndMinutes(192_000)).toBe("53 h 20 min");
  expect(hoursAndMinutes(360_000)).toBe("100 h");
  expect(hoursAndMinutes(2700)).toBe("45 min");
  expect(hoursAndMinutes(0)).toBe("0 h");
});

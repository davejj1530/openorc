import type { OrganizationBilling, OrganizationBillingPage } from "@openorc/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationBillingPayment, type OrganizationPaymentRecord } from "./organization-billing-payment.js";
import { OutOfReach, Refused } from "./session.js";

const checkout: OrganizationBillingPage = { page: "checkout", plan: "yearly", seats: 3 };
const url = "https://example.com/checkout/one";
const empty: OrganizationBilling = { organization: { id: "team-a", name: "Example team", logo: null }, revision: "1", asOf: 1000, subscription: null, seats: [], available: 0 };
const paid: OrganizationBilling = {
  ...empty,
  revision: "2",
  available: 3,
  subscription: { id: "subscription-a", plan: "yearly", standing: "live", paidUntil: 2000, graceUntil: null, quantity: 3, overallocated: false, pendingQuantity: null },
};
const instances: OrganizationBillingPayment[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
  vi.useRealTimers();
});

function fixture() {
  let record: OrganizationPaymentRecord | null = null;
  let billing = empty;
  let current = true;
  const order: string[] = [];
  const browser = { open: vi.fn<(url: string) => void>() };
  const link = vi.fn(async (_target: OrganizationBillingPage) => {
    order.push("request");
    return { url };
  });
  const reread = vi.fn(async () => {
    payment.heard(billing);
  });
  const deps = {
    now: () => Date.now(),
    browser,
    load: () => record,
    save: (value: OrganizationPaymentRecord) => {
      order.push("save");
      record = structuredClone(value);
    },
    current: () => current,
    billing: () => billing,
    link,
    reread,
    changed: vi.fn(),
  };
  let payment = new OrganizationBillingPayment(deps);
  instances.push(payment);
  return {
    payment,
    deps,
    order,
    link,
    reread,
    browser,
    record: () => record,
    pay: () => {
      billing = paid;
      payment.heard(billing);
    },
    revoke: () => {
      current = false;
      payment.close();
    },
    restart: () => {
      payment.close();
      payment = new OrganizationBillingPayment(deps);
      instances.push(payment);
      return payment;
    },
  };
}

describe("organization payment", () => {
  it("stores the exact request and id before sending, coalesces double clicks and keeps its URL private", async () => {
    const f = fixture();
    await Promise.all([f.payment.open(checkout), f.payment.open(checkout)]);
    expect(f.order.slice(0, 2)).toEqual(["save", "request"]);
    expect(f.record()).toMatchObject({ target: checkout, id: expect.any(String) });
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.browser.open).toHaveBeenCalledExactlyOnceWith(url);
    expect(f.payment.work).toMatchObject({ state: "waiting", watching: true, target: checkout });
    expect(JSON.stringify(f.payment.work)).not.toContain(url);
  });

  it("reopens the same page while waiting without a second checkout", async () => {
    const f = fixture();
    await f.payment.open(checkout);
    await f.payment.open(checkout);
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.browser.open.mock.calls).toEqual([[url], [url]]);
    expect(f.payment.work?.target).toEqual(checkout);
  });

  it("stores an explicit changed purchase before updating the same pending checkout", async () => {
    const f = fixture();
    await f.payment.open(checkout);
    f.payment.leave();
    f.order.length = 0;
    const target: OrganizationBillingPage = { page: "checkout", plan: "monthly", seats: 8 };
    await f.payment.open(target);
    expect(f.link.mock.calls).toEqual([[checkout], [target]]);
    expect(f.order.slice(0, 2)).toEqual(["save", "request"]);
    expect(f.browser.open.mock.calls).toEqual([[url], [url]]);
    expect(f.payment.work?.target).toEqual(target);
  });

  it("keeps a lost response pending across restart and repeats only the stored request on a press", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.link.mockRejectedValueOnce(new OutOfReach());
    await f.payment.open(checkout);
    const first = f.record();
    expect(f.payment.work).toMatchObject({ state: "pending", target: checkout });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.link).toHaveBeenCalledTimes(1);
    const again = f.restart();
    expect(again.work).toMatchObject({ id: first?.id, state: "pending", watching: false });
    await again.open({ page: "checkout", plan: "monthly", seats: 1 });
    expect(f.link.mock.calls).toEqual([[checkout], [checkout]]);
    expect(again.work).toMatchObject({ id: first?.id, state: "waiting" });
  });

  it("keeps the known page after browser failure and opens it again without repeating the write", async () => {
    const f = fixture();
    f.browser.open.mockImplementationOnce(() => {
      throw new Error("The browser could not open.");
    });
    await f.payment.open(checkout);
    expect(f.payment.work).toMatchObject({ state: "waiting", error: "The browser could not open." });
    await f.payment.open(checkout);
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.payment.work?.error).toBeNull();
  });

  it("a return or unchanged read does not confirm payment; only a paid inventory does", async () => {
    const f = fixture();
    await f.payment.open(checkout);
    f.payment.heard(empty);
    expect(f.payment.work?.state).toBe("waiting");
    f.pay();
    expect(f.payment.work).toMatchObject({ state: "complete", watching: false });
    await f.payment.open(checkout);
    expect(f.link).toHaveBeenCalledTimes(1);
  });

  it("polls reads every ten seconds, repairs a missed topic and never retries a write automatically", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.payment.open(checkout);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.reread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reread).toHaveBeenCalledTimes(1);
    f.reread.mockImplementation(async () => f.payment.heard(paid));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.payment.work?.state).toBe("complete");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reread).toHaveBeenCalledTimes(2);
    expect(f.link).toHaveBeenCalledTimes(1);
  });

  it("Stop waiting ends only the watch and still discovers a late successful payment", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.payment.open(checkout);
    f.payment.leave();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reread).not.toHaveBeenCalled();
    expect(f.payment.work).toMatchObject({ state: "waiting", watching: false });
    f.pay();
    expect(f.payment.work?.state).toBe("complete");
  });

  it("ends a temporary watch after fifteen minutes without making up a payment failure", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.payment.open(checkout);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.payment.work).toMatchObject({ state: "waiting", watching: false, error: null });
    const reads = f.reread.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reread).toHaveBeenCalledTimes(reads);
  });

  it("keeps an already-paid write complete when the following read fails", async () => {
    const f = fixture();
    f.link.mockRejectedValueOnce(new Refused("This organization already pays for seats. Change the number of seats in billing.", 409));
    f.reread.mockRejectedValueOnce(new OutOfReach());
    await f.payment.open(checkout);
    expect(f.payment.work).toMatchObject({ state: "complete", watching: false });
    await f.payment.open(checkout);
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.reread).toHaveBeenCalledTimes(1);
  });

  it("shows definitive refusals and leaves vendor failures unresolved", async () => {
    const f = fixture();
    f.link.mockRejectedValueOnce(new Refused("Only an admin can do that.", 403));
    await f.payment.open(checkout);
    expect(f.payment.work).toMatchObject({ state: "failed", error: "Only an admin can do that." });
    f.link.mockRejectedValueOnce(new Refused("The payment service could not be reached.", 503));
    await f.payment.open(checkout);
    expect(f.payment.work).toMatchObject({ state: "pending", error: "The payment service could not be reached." });
  });

  it("ends a coded provider refusal and permits a new purchase only on the next press", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.link.mockRejectedValueOnce(new Refused("The payment provider answered 500. Try again in a moment.", 502, "organization_payment_refused"));
    await f.payment.open(checkout);
    const failed = f.record();
    expect(f.payment.work).toMatchObject({ state: "failed", watching: false, error: "The payment provider answered 500. Try again in a moment." });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.reread).not.toHaveBeenCalled();
    const target: OrganizationBillingPage = { page: "checkout", plan: "monthly", seats: 4 };
    await f.payment.open(target);
    expect(f.link.mock.calls).toEqual([[checkout], [target]]);
    expect(f.payment.work).toMatchObject({ state: "waiting", target });
    expect(f.payment.work?.id).not.toBe(failed?.id);
  });

  it.each([
    new Refused("The payment provider answered 500. Try again in a moment.", 502),
    new Refused("The payment page could not be opened.", 502, "unknown_code"),
    new Refused("The payment page could not be opened.", 503, "organization_payment_refused"),
  ])("keeps an unclassified gateway failure unresolved without inferring a deadline", async (error) => {
    vi.useFakeTimers();
    const f = fixture();
    f.link.mockRejectedValueOnce(error);
    await f.payment.open(checkout);
    const pending = f.record();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.payment.work).toMatchObject({ state: "pending", id: pending?.id });
    expect(f.link).toHaveBeenCalledTimes(1);
    expect(f.browser.open).not.toHaveBeenCalled();
    await f.payment.open({ page: "checkout", plan: "monthly", seats: 4 });
    expect(f.link.mock.calls).toEqual([[checkout], [checkout]]);
  });

  it("does not request a payment page without a browser", async () => {
    const f = fixture();
    const bare = new OrganizationBillingPayment({ ...f.deps, browser: undefined });
    instances.push(bare);
    await expect(bare.open(checkout)).rejects.toThrow("This device can't open the payment page.");
    expect(f.link).not.toHaveBeenCalled();
    expect(f.record()).toBeNull();
  });

  it("fences a late checkout link after losing its account or admin membership", async () => {
    const f = fixture();
    let resolve: (value: { url: string }) => void = () => undefined;
    f.link.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const opening = f.payment.open(checkout);
    f.revoke();
    resolve({ url });
    await opening;
    expect(f.browser.open).not.toHaveBeenCalled();
    expect(f.payment.work).toBeNull();
  });

  it("stores a late checkout link without opening a browser after Stop waiting", async () => {
    const f = fixture();
    let resolve: (value: { url: string }) => void = () => undefined;
    f.link.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const opening = f.payment.open(checkout);
    f.payment.leave();
    resolve({ url });
    await opening;
    expect(f.browser.open).not.toHaveBeenCalled();
    expect(f.payment.work).toMatchObject({ state: "waiting", watching: false });
    await f.payment.open(checkout);
    expect(f.browser.open).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("keeps the server's unresolved payment refusal pending and only polls reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.link.mockRejectedValueOnce(new Refused("This organization's payment is still being checked. Try again in a moment.", 409, "organization_payment_pending"));
    await f.payment.open(checkout);
    expect(f.payment.work).toMatchObject({ state: "pending", watching: true, target: checkout });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.reread).toHaveBeenCalledTimes(1);
    expect(f.link).toHaveBeenCalledTimes(1);
    f.pay();
    expect(f.payment.work?.state).toBe("complete");
  });
});

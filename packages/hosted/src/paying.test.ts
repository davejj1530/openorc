import type { AccountStatus } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser, type Device, type Seen, type TestBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 0, packsLeftSeconds: 0 } as const;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];
/** The pages the person's browser was sent to, in order. */
let opened: string[];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  opened = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

/** Signed in through the browser, whose other pages (Polar's) are only opened; `overrides` apply to the host made then. */
async function signedIn(overrides: Partial<HostedDeps> = {}): Promise<{ hosted: Hosted; seen: Seen; browser: TestBrowser }> {
  const browser = testBrowser(stand, (url) => void opened.push(url));
  const { deps, seen } = hostDeps(stand, device, { browser, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  if (hosted.account.status().state !== "signed-in") await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(status(hosted).reach).toBe("live"));
  return { hosted, seen, browser };
}

const status = (hosted: Hosted) => hosted.account.status() as Extract<AccountStatus, { state: "signed-in" }>;
const billingReads = (seen: Seen) => seen.timeline.filter((line) => line === "request /billing").length;

describe("paying", () => {
  it("coalesces concurrent opens and reopens the same checkout with its original period", async () => {
    const { hosted } = await signedIn();
    await Promise.all([hosted.account.openBilling({ page: "pro", period: "yearly" }), hosted.account.openBilling({ page: "pro", period: "yearly" })]);
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    expect(stand.checkouts).toHaveLength(1);
    expect(opened).toEqual([stand.checkouts[0]!.url, stand.checkouts[0]!.url]);
    expect(status(hosted).paying).toMatchObject({ page: "pro", period: "yearly" });
    hosted.account.leaveBilling();
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    expect(stand.checkouts).toHaveLength(2);
    expect(status(hosted).paying).toMatchObject({ page: "pro", period: "monthly" });
  });

  it("reopens the same hours checkout without making another", async () => {
    stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 3600 });
    const { hosted } = await signedIn();
    await hosted.account.openBilling({ page: "hours" });
    await hosted.account.openBilling({ page: "hours" });
    expect(stand.checkouts).toHaveLength(1);
    expect(opened).toEqual([stand.checkouts[0]!.url, stand.checkouts[0]!.url]);
  });

  it("does not open a checkout whose answer arrives after sign-out", async () => {
    const release = Promise.withResolvers<void>();
    const { hosted } = await signedIn({
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/billing/checkout/pro")) await release.promise;
        return response;
      },
    });
    const opening = hosted.account.openBilling({ page: "pro", period: "monthly" });
    await vi.waitFor(() => expect(stand.checkouts).toHaveLength(1));
    await hosted.account.signOut();
    release.resolve();
    await opening;
    expect(opened).toEqual([]);
    expect(hosted.account.status().state).toBe("signed-out");
  });

  it("opens the yearly Pro checkout in the browser alone, and shows Pro once the server says it was paid", async () => {
    const { hosted, seen } = await signedIn();
    await hosted.account.openBilling({ page: "pro", period: "yearly" });
    expect(stand.checkouts.map(({ page, plan }) => ({ page, plan }))).toEqual([{ page: "pro", plan: "yearly" }]);
    expect(opened).toEqual([stand.checkouts[0]!.url]);
    expect(status(hosted).paying).toMatchObject({ page: "pro" });
    expect(JSON.stringify([seen.pushes, seen.logs, hosted.account.status()])).not.toContain(stand.checkouts[0]!.url);
    stand.pay(ADA);
    await vi.waitFor(() => expect(status(hosted)).toMatchObject({ plan: { pro: true, standing: "live" }, paying: null }));
    expect(status(hosted).hours?.leftSeconds).toBeGreaterThan(0);
  });

  it("notices a purchase whose topic was lost by reading billing every ten seconds while the page is open", async () => {
    const { hosted, seen } = await signedIn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    stand.pay(ADA, { quiet: true });
    const before = billingReads(seen);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(status(hosted).plan.pro).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(status(hosted)).toMatchObject({ plan: { pro: true }, paying: null }));
    expect(billingReads(seen)).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(billingReads(seen)).toBe(before + 1);
  });

  it("sees a pack bought as more hours, and hours used meanwhile as no purchase", async () => {
    stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 3600 });
    const { hosted } = await signedIn();
    await vi.waitFor(() => expect(status(hosted).plan.pro).toBe(true));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await hosted.account.openBilling({ page: "hours" });
    stand.setBilling(ADA, PRO);
    await vi.advanceTimersByTimeAsync(10_500);
    await vi.waitFor(() => expect(status(hosted).hours?.leftSeconds).toBe(0));
    expect(status(hosted).paying).toMatchObject({ page: "hours" });
    stand.pay(ADA);
    await vi.waitFor(() => expect(status(hosted).paying).toBeNull());
    expect(status(hosted).hours).toMatchObject({ leftSeconds: 20 * 3600, packsLeftSeconds: 20 * 3600 });
  });

  it("stops reading when the person leaves, and after fifteen minutes with nothing bought", async () => {
    const { hosted, seen } = await signedIn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    hosted.account.leaveBilling();
    expect(status(hosted).paying).toBeNull();
    const left = billingReads(seen);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(billingReads(seen)).toBe(left);

    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(status(hosted).paying).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(status(hosted).paying).toBeNull();
    const ended = billingReads(seen);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(billingReads(seen)).toBe(ended);
  });

  it("opens the billing portal only for a person who bought something, and says why not in the server's words", async () => {
    const { hosted } = await signedIn();
    await expect(hosted.account.openBilling({ page: "billing" })).rejects.toThrow("You haven't bought anything yet, so there is no billing to manage.");
    await expect(hosted.account.openBilling({ page: "hours" })).rejects.toThrow("Hours packs are for Pro. Upgrade to Pro first.");
    expect([opened, status(hosted).paying]).toEqual([[], null]);
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    stand.pay(ADA);
    await vi.waitFor(() => expect(status(hosted).plan.pro).toBe(true));
    await expect(hosted.account.openBilling({ page: "pro", period: "yearly" })).rejects.toThrow("You already pay for Pro. Change your plan in billing.");
    await hosted.account.openBilling({ page: "billing" });
    expect(opened.at(-1)).toContain("/stand-in/portal/");
    expect(status(hosted).paying).toMatchObject({ page: "billing" });
  });

  it("asks for no page on a device with no browser, and forgets a page opened once signed out", async () => {
    (await signedIn()).hosted.close();
    const bare = await signedIn({ browser: undefined });
    await expect(bare.hosted.account.openBilling({ page: "pro", period: "monthly" })).rejects.toThrow("This device can't open the payment page.");
    expect(stand.checkouts).toEqual([]);
    bare.hosted.close();
    const { hosted, browser } = await signedIn();
    await hosted.account.openBilling({ page: "pro", period: "monthly" });
    await hosted.account.signOut();
    await signInAs(hosted, browser, ADA);
    expect(status(hosted).paying).toBeNull();
  });

  it("reads what Pro and a pack cost from the server, in the periods this app pays by, and nothing when it can't say", async () => {
    const { hosted, seen } = await signedIn();
    stand.setOffers({
      monthlySeconds: 75 * 3600,
      pro: [
        { plan: "monthly", price: { amount: 2000, currency: "usd" } },
        { plan: "weekly", price: { amount: 600, currency: "usd" } },
        { plan: "yearly", price: null },
      ],
      hours: { seconds: 50 * 3600, months: 12, price: { amount: 1000, currency: "eur" } },
    });
    expect(await hosted.account.offers()).toEqual({
      monthlySeconds: 75 * 3600,
      pro: [
        { period: "monthly", price: { amount: 2000, currency: "usd" } },
        { period: "yearly", price: null },
      ],
      hours: { seconds: 50 * 3600, months: 12, price: { amount: 1000, currency: "eur" } },
    });
    stand.setOffers(null);
    expect(await hosted.account.offers()).toBeNull();
    await hosted.account.signOut();
    const asked = seen.timeline.filter((line) => line === "request /billing/offers").length;
    expect(await hosted.account.offers()).toBeNull();
    expect(seen.timeline.filter((line) => line === "request /billing/offers").length).toBe(asked);
  });
});

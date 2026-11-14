import { afterEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import type { WireBilling } from "./wire.js";

const email = "person@example.com";
const until = "2026-12-01T00:00:00.000Z";
const active: WireBilling = {
  pro: { status: "pro", standing: "live", renewsAt: until, paidBy: { kind: "organization", organizationId: "team-one" } },
  period: { startsAt: "2026-11-01T00:00:00.000Z", endsAt: until },
  monthly: { grantedSeconds: 360000, usedSeconds: 212400, leftSeconds: 147600 },
  packs: [],
  leftSeconds: 147600,
  organizationAccess: { state: "active", reason: null, until: null, message: null },
  allowanceSource: { kind: "organization", organizationId: "team-one", organizationName: "Studio" },
};
const hosts: Hosted[] = [];
let server: StandIn;
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.close();
  await server?.close();
});

async function setup(initial = active) {
  server = await standIn({ signup: "open" });
  const device = newDevice();
  let billing = initial;
  let held: { reached(): void; wait: Promise<void> } | null = null;
  const start = async () => {
    const context = hostDeps(server, device, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (new URL(String(url)).pathname !== "/billing" || !response.ok) return response;
        const snapshot = billing;
        const hold = held;
        held = null;
        if (hold) {
          hold.reached();
          await hold.wait;
        }
        return Response.json(snapshot);
      },
    });
    const host = createHosted(context.deps);
    hosts.push(host);
    await host.start();
    return { host, ...context };
  };
  const context = await start();
  await signInAs(context.host, context.browser, email);
  await vi.waitFor(() => expect(context.host.account.status()).toMatchObject({ plan: { pro: true } }));
  return {
    ...context,
    start,
    setBilling: (next: WireBilling) => (billing = next),
    hold: () => {
      const reached = gate();
      const wait = gate();
      held = { reached: reached.resolve, wait: wait.promise };
      return { reached: reached.promise, release: wait.resolve };
    },
  };
}

it("keeps only the selected source and authoritative hours through an offline restart", async () => {
  const { host, start } = await setup();
  expect(host.account.status()).toMatchObject({ allowanceSource: active.allowanceSource, paidBy: "organization", organizationAccess: active.organizationAccess, hours: { leftSeconds: 147600 } });
  host.close();
  await server.down();
  const restarted = await start();
  expect(restarted.host.account.status()).toMatchObject({ reach: "offline", allowanceSource: active.allowanceSource, organizationAccess: active.organizationAccess, hours: { leftSeconds: 147600 } });
});

it("drops a billing read from an ended session even when the same person signs in again", async () => {
  const { host, browser, hold, setBilling } = await setup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await host.account.openBilling({ page: "pro", period: "monthly" });
  const response = hold();
  await vi.advanceTimersByTimeAsync(10500);
  await response.reached;
  await host.account.signOut();
  setBilling({ ...active, pro: { status: "pro", standing: "live", renewsAt: until, paidBy: { kind: "self" } }, allowanceSource: { kind: "self" } });
  await signInAs(host, browser, email);
  await vi.waitFor(() => expect(host.account.status()).toMatchObject({ paidBy: "self" }));
  response.release();
  await vi.advanceTimersByTimeAsync(100);
  expect(host.account.status()).toMatchObject({ paidBy: "self", allowanceSource: { kind: "self" } });
});

it("keeps waiting for personal payment while an organization already supplies Pro", async () => {
  const { host, setBilling } = await setup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await host.account.openBilling({ page: "pro", period: "monthly" });
  setBilling({ ...active, leftSeconds: 10000 });
  await vi.advanceTimersByTimeAsync(10500);
  await vi.waitFor(() => expect(host.account.status()).toMatchObject({ hours: { leftSeconds: 10000 } }));
  expect(host.account.status()).toMatchObject({ paying: { page: "pro", period: "monthly" } });
  await host.account.openBilling({ page: "pro", period: "yearly" });
  expect(server.checkouts).toHaveLength(1);
  setBilling({ ...active, pro: { status: "pro", standing: "live", renewsAt: until, paidBy: { kind: "self" } }, allowanceSource: { kind: "self" } });
  await vi.advanceTimersByTimeAsync(10500);
  await vi.waitFor(() => expect(host.account.status()).toMatchObject({ paying: null, allowanceSource: { kind: "self" }, paidBy: "self" }));
});

it("normalizes a private grace deadline and preserves packs without an included grant", async () => {
  const message = "Your seat was taken back; you have one day to get Pro to keep using organizations.";
  const { host } = await setup({
    ...active,
    pro: { status: "pro", standing: "grace", until, paidBy: { kind: "organization", organizationId: "team-one" } },
    organizationAccess: { state: "grace", reason: "seat_removed", until, message },
    allowanceSource: null,
    period: null,
    monthly: null,
    packs: [{ grantedSeconds: 21600, usedSeconds: 0, leftSeconds: 21600, boughtAt: "2026-10-01T00:00:00.000Z", expiresAt: "2027-10-01T00:00:00.000Z" }],
    leftSeconds: 21600,
  });
  expect(host.account.status()).toMatchObject({
    organizationAccess: { state: "grace", reason: "seat_removed", until: Date.parse(until), message },
    allowanceSource: null,
    paidBy: "organization",
    hours: { leftSeconds: 21600, monthly: null, packsLeftSeconds: 21600 },
  });
  expect(JSON.stringify(host.account.status())).not.toContain("team-one");
});

it("reads the same private gate from the real stand-in's account and spaces without changing membership", async () => {
  server = await standIn({ signup: "open" });
  const team = server.addTeam("Studio", [email]);
  const message = "Your seat was taken back; you have one day to get Pro to keep using organizations.";
  server.setBilling(email, {
    pro: true,
    standing: "grace",
    at: until,
    monthlyLeftSeconds: 9000,
    packsLeftSeconds: 21600,
    allowanceSource: null,
    paidBy: { kind: "organization", organizationId: team },
    organizationAccess: { state: "grace", reason: "seat_removed", until, message },
  });
  const context = hostDeps(server, newDevice());
  const host = createHosted(context.deps);
  hosts.push(host);
  await host.start();
  await signInAs(host, context.browser, email);
  await host.spaces.refresh();
  expect(host.account.status()).toMatchObject({ hours: { monthly: null, leftSeconds: 21600 }, organizationAccess: { state: "grace", until: Date.parse(until), message } });
  expect(host.spaces.status()).toMatchObject({ organizationAccess: { state: "grace", until: Date.parse(until), message }, spaces: expect.arrayContaining([expect.objectContaining({ id: team })]) });
});

it("preserves the real removed-seat wire's packs during access-only grace without inventing a payer", async () => {
  const message = "Your seat was taken back; you have one day to get Pro to keep using organizations.";
  server = await standIn({ signup: "open" });
  server.setBilling(email, { pro: false, packsLeftSeconds: 21600, organizationAccess: { state: "grace", reason: "seat_removed", until, message }, allowanceSource: null });
  const context = hostDeps(server, newDevice());
  const removed = createHosted(context.deps);
  hosts.push(removed);
  await removed.start();
  await signInAs(removed, context.browser, email);
  await vi.waitFor(() => expect(removed.account.status()).toMatchObject({ plan: { pro: false }, organizationAccess: { state: "grace" }, hours: { monthly: null, leftSeconds: 21600 }, paidBy: null }));
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, storedToken, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const GRACE = "grace@example.com";
const RENEWS = "2026-12-12T00:00:00.000Z";

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function host(overrides: Parameters<typeof hostDeps>[2] = {}) {
  const { deps, seen } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  return { account: hosted.account, hosted, seen };
}

async function signIn(account: Hosted["account"], email: string) {
  await account.sendCode(email);
  await account.signIn(email, stand.codeFor(email)!);
}

describe("the account", () => {
  it("signs in with a code the server takes, and shows the address", async () => {
    const { account, seen } = await host();
    expect(account.status()).toEqual({ state: "signed-out", codeSentTo: null, ended: false, error: null });
    await signIn(account, ADA);
    expect(account.status()).toMatchObject({ state: "signed-in", email: ADA, plan: { pro: false }, hours: null, error: null });
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["account"] });
  });

  it("says a wrong code is wrong in the server's words and keeps nothing", async () => {
    const { account } = await host();
    await account.sendCode(ADA);
    await expect(account.signIn(ADA, "000000")).rejects.toThrow("That code isn't right. Check the email and type it again.");
    expect(account.status()).toMatchObject({ state: "signed-out" });
    expect(device).toMatchObject({ stored: null, kept: null, threads: null });
  });

  it("reads an address nobody invited as words, not as a code name", async () => {
    await stand.close();
    stand = await standIn({ signup: "invite", invited: [GRACE] });
    const { account } = await host();
    const refusal = await account.sendCode(ADA).catch((error: Error) => error.message);
    expect(refusal).toBe("This email doesn't belong to any organization yet.");
    expect(refusal).not.toContain("NOT_INVITED");
    await account.sendCode(GRACE);
    expect(account.status()).toMatchObject({ codeSentTo: GRACE });
  });

  it("remembers where the code went until sign-in or ten minutes", async () => {
    let now = Date.now();
    const { account } = await host({ now: () => now });
    await account.sendCode(ADA);
    expect(account.status()).toMatchObject({ state: "signed-out", codeSentTo: ADA });
    now += 9 * 60_000;
    expect(account.status()).toMatchObject({ codeSentTo: ADA });
    now += 2 * 60_000;
    expect(account.status()).toMatchObject({ codeSentTo: null });
    await account.sendCode(ADA);
    await account.signIn(ADA, stand.codeFor(ADA)!);
    await account.signOut();
    expect(account.status()).toMatchObject({ state: "signed-out", codeSentTo: null });
  });

  it("shows Pro with its standing and its date, and Free with no hours", async () => {
    stand.setBilling(ADA, { pro: true, standing: "ending", at: RENEWS, monthlyLeftSeconds: 3_600, packsLeftSeconds: 0 });
    const { account } = await host();
    await signIn(account, ADA);
    expect(account.status()).toMatchObject({ plan: { pro: true, standing: "ending", at: Date.parse(RENEWS) } });
    await signIn(account, GRACE);
    expect(account.status()).toMatchObject({ email: GRACE, plan: { pro: false }, hours: null });
  });

  it("adds the month's hours and the packs' into the hours left", async () => {
    stand.setBilling(ADA, { pro: true, standing: "live", at: RENEWS, monthlyLeftSeconds: 7_200, packsLeftSeconds: 1_800 });
    const { account } = await host();
    await signIn(account, ADA);
    expect(account.status()).toMatchObject({
      plan: { pro: true, standing: "live", at: Date.parse(RENEWS) },
      hours: { leftSeconds: 9_000, packsLeftSeconds: 1_800, monthly: { grantedSeconds: 40 * 3_600, leftSeconds: 7_200, resetsAt: Date.parse(RENEWS) } },
    });
  });

  it("starts signed in with the server down showing the last plan heard, offline", async () => {
    stand.setBilling(ADA, { pro: true, standing: "live", at: RENEWS, monthlyLeftSeconds: 7_200, packsLeftSeconds: 0 });
    const first = await host();
    await signIn(first.account, ADA);
    first.hosted.close();
    await stand.down();
    const { account } = await host();
    expect(account.status()).toMatchObject({ state: "signed-in", email: ADA, reach: "offline", plan: { pro: true, standing: "live" }, hours: { leftSeconds: 7_200 } });
    await stand.up();
    await vi.waitFor(() => expect(account.status()).toMatchObject({ reach: "live" }));
  });

  it("forgets the token and the kept answers before it tells the server, and signs out with the server down", async () => {
    const { account, seen } = await host();
    await signIn(account, ADA);
    const token = storedToken(device);
    seen.timeline.length = 0;
    await account.signOut();
    await vi.waitFor(() => expect(seen.timeline).toContain("request /api/auth/sign-out"));
    expect(seen.timeline.indexOf("kept forgotten")).toBeLessThan(seen.timeline.indexOf("request /api/auth/sign-out"));
    expect(seen.timeline.indexOf("session forgotten")).toBeLessThan(seen.timeline.indexOf("request /api/auth/sign-out"));
    expect(device).toMatchObject({ stored: null, kept: null, threads: null });
    await vi.waitFor(async () => expect((await fetch(`${stand.url}/billing`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401));

    await signIn(account, ADA);
    await stand.down();
    await account.signOut();
    expect(account.status()).toEqual({ state: "signed-out", codeSentTo: null, ended: false, error: null });
    expect(device).toMatchObject({ stored: null, kept: null, threads: null });
  });

  it("signs the first address out when signing in as another", async () => {
    const { account } = await host();
    await signIn(account, ADA);
    const first = storedToken(device);
    await signIn(account, GRACE);
    expect(account.status()).toMatchObject({ state: "signed-in", email: GRACE });
    await vi.waitFor(async () => expect((await fetch(`${stand.url}/billing`, { headers: { authorization: `Bearer ${first}` } })).status).toBe(401));
    expect((await fetch(`${stand.url}/billing`, { headers: { authorization: `Bearer ${storedToken(device)}` } })).status).toBe(200);
  });

  it("names the person as the server does, and keeps a picture only when a window can draw it", async () => {
    const { account } = await host();
    await signIn(account, "ada.lovelace@example.com");
    expect(account.status()).toMatchObject({ name: "Ada Lovelace", image: null });
    stand.setPerson(GRACE, { name: "Grace Hopper", image: "https://example.com/grace.png" });
    await signIn(account, GRACE);
    expect(account.status()).toMatchObject({ name: "Grace Hopper", image: null });
    stand.setPerson(ADA, { name: "Ada", image: "data:image/png;base64,iVBORw0KGgo=" });
    await signIn(account, ADA);
    expect(account.status()).toMatchObject({ name: "Ada", image: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("signs out when the server no longer holds the session it was asked about", async () => {
    const first = await host();
    await signIn(first.account, ADA);
    first.hosted.close();
    stand.revoke();
    const { account } = await host();
    await vi.waitFor(() => expect(account.status()).toEqual({ state: "signed-out", codeSentTo: null, ended: true, error: null }));
    expect(device).toMatchObject({ stored: null, kept: null, threads: null });
  });

  it("says where cloud threads run, in the server's names, and changes it", async () => {
    await stand.close();
    stand = await standIn({ signup: "open", services: ["vercel", "agent37"] });
    const { account } = await host();
    await signIn(account, ADA);
    expect(account.status()).toMatchObject({
      sandbox: {
        chosen: null,
        fallback: "vercel",
        services: [
          { id: "vercel", name: "Vercel" },
          { id: "agent37", name: "Agent37" },
        ],
      },
    });
    await account.setSandbox("agent37");
    expect(account.status()).toMatchObject({ sandbox: { chosen: "agent37" } });
    expect(stand.sandboxes.get(ADA)).toBe("agent37");
    await expect(account.setSandbox("local")).rejects.toThrow("This server doesn't run threads on this machine.");
    expect(account.status()).toMatchObject({ sandbox: { chosen: "agent37" } });
    await account.setSandbox(null);
    expect(account.status()).toMatchObject({ sandbox: { chosen: null, fallback: "vercel" } });
  });

  it("shows where threads run offline after a restart, as last heard", async () => {
    await stand.close();
    stand = await standIn({ signup: "open", services: ["vercel", "agent37"] });
    const first = await host();
    await signIn(first.account, ADA);
    await first.account.setSandbox("agent37");
    first.hosted.close();
    await stand.down();
    const { account } = await host();
    expect(account.status()).toMatchObject({ reach: "offline", name: "Ada", sandbox: { chosen: "agent37" } });
  });
});

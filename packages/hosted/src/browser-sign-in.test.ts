import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, storedToken, type Device, type Seen, type TestBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";

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

/** A host whose fetch records every body it sends, so a test can look for its secrets where they must not be. */
async function host(overrides: Partial<HostedDeps> = {}): Promise<{ hosted: Hosted; seen: Seen; browser: TestBrowser; sent: string[] }> {
  const sent: string[] = [];
  const made = hostDeps(stand, device, overrides);
  const fetching = made.deps.fetch;
  made.deps.fetch = (input, init) => {
    if (typeof init?.body === "string") sent.push(init.body);
    return fetching(input, init);
  };
  const hosted = createHosted(made.deps);
  hosts.push(hosted);
  await hosted.start();
  return { hosted, seen: made.seen, browser: made.browser, sent };
}

const signingIn = (hosted: Hosted) => {
  const status = hosted.account.status();
  return status.state === "signed-out" ? status.signingIn : "signed in";
};

describe("signing in through the browser", () => {
  it("opens the sign-in page, and keeps the session the page hands back", async () => {
    const { hosted, browser } = await host();
    await hosted.account.signIn();
    const page = browser.opened[0]!;
    expect(new URL(page).pathname).toBe("/sign-in");
    expect(signingIn(hosted)).toEqual({ state: "waiting", page });
    expect(stand.appSignIns.devices).toEqual(["OpenOrc on this Mac"]);

    browser.back(stand.signInPage(page, ADA));
    await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", email: ADA }));
    expect(storedToken(device)).toMatch(/^[^.]+\.[^.]+$/);
    await hosted.account.signOut();
    expect(hosted.account.status()).toEqual({ state: "signed-out", signingIn: null, ended: false, error: null });
  });

  it("opens the same page again when asked while one waits, and does nothing once signed in", async () => {
    const { hosted, browser } = await host();
    await Promise.all([hosted.account.signIn(), hosted.account.signIn()]);
    await hosted.account.signIn();
    expect(browser.opened).toHaveLength(2);
    expect(new Set(browser.opened).size).toBe(1);
    expect(stand.requests.filter((request) => request.path === "/app-sign-in/start")).toHaveLength(1);
    browser.back(stand.signInPage(browser.opened[0]!, ADA));
    await vi.waitFor(() => expect(hosted.account.status().state).toBe("signed-in"));
    await hosted.account.signIn();
    expect(browser.opened).toHaveLength(2);
  });

  it("ends with no words when cancelled, and a page approved afterwards signs nobody in", async () => {
    const { hosted, browser } = await host();
    await hosted.account.signIn();
    const page = browser.opened[0]!;
    hosted.account.cancelSigningIn();
    expect(hosted.account.status()).toEqual({ state: "signed-out", signingIn: null, ended: false, error: null });
    await vi.waitFor(() => expect(stand.requests.some((request) => request.path === "/app-sign-in/cancel")).toBe(true));
    expect(() => stand.signInPage(page, ADA)).toThrow("This sign-in can't be finished.");
    expect(stand.requests.some((request) => request.path === "/app-sign-in/finish")).toBe(false);
    expect(device.stored).toBeNull();
  });

  it("cancels a request whose start answer arrives after the person canceled", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const { hosted, browser } = await host({
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (new URL(String(input)).pathname === "/app-sign-in/start") {
          started = true;
          await held;
        }
        return response;
      },
    });
    const opening = hosted.account.signIn();
    await vi.waitFor(() => expect(started).toBe(true));
    hosted.account.cancelSigningIn();
    release();
    await opening;
    await vi.waitFor(() => expect(stand.requests.some((request) => request.path === "/app-sign-in/cancel")).toBe(true));
    expect(browser.opened).toEqual([]);
    expect(signingIn(hosted)).toBeNull();
  });

  it("does not wait for the server when cancellation cannot reach it", async () => {
    const { hosted, browser } = await host();
    await hosted.account.signIn();
    await stand.down();
    hosted.account.cancelSigningIn();
    expect(signingIn(hosted)).toBeNull();
    expect(browser.opened).toHaveLength(1);
    await stand.up();
  });

  it("says so in words when the request ran out before the browser came back", async () => {
    const { hosted, browser } = await host();
    await hosted.account.signIn();
    const returnTo = stand.signInPage(browser.opened[0]!, ADA);
    stand.appSignIns.expire();
    browser.back(returnTo);
    await vi.waitFor(() => expect(signingIn(hosted)).toEqual({ state: "failed", error: "This sign-in can't be finished. Sign in again." }));
    expect(device.stored).toBeNull();
  });

  it("says so in words when the browser never comes back", async () => {
    const TIMED_OUT = "The browser didn't come back in time. Try again.";
    const query = Promise.reject(new Error(TIMED_OUT));
    query.catch(() => undefined);
    const { hosted } = await host({ browser: { awaitReturn: async () => ({ port: 40_001, query, close: () => undefined }), open: () => undefined } });
    await hosted.account.signIn();
    await vi.waitFor(() => expect(signingIn(hosted)).toEqual({ state: "failed", error: TIMED_OUT }));
    await vi.waitFor(() => expect(stand.requests.some((request) => request.path === "/app-sign-in/cancel")).toBe(true));
  });

  it("says the server can't be reached, and asking again tries again", async () => {
    const { hosted, browser } = await host();
    await stand.down();
    await hosted.account.signIn();
    expect(signingIn(hosted)).toEqual({ state: "failed", error: "OpenOrc Cloud can't be reached." });
    expect(browser.opened).toEqual([]);
    await stand.up();
    browser.person = ADA;
    await hosted.account.signIn();
    await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", email: ADA }));
  });

  it("refuses a return that isn't for its request, or whose finish the server refuses, in words", async () => {
    const { hosted, browser } = await host();
    await hosted.account.signIn();
    const returnTo = new URL(stand.signInPage(browser.opened[0]!, ADA));
    returnTo.searchParams.set("code", "not-the-code");
    browser.back(returnTo.href);
    await vi.waitFor(() => expect(signingIn(hosted)).toEqual({ state: "failed", error: "This sign-in can't be finished. Sign in again." }));

    await hosted.account.signIn();
    const other = new URL(stand.signInPage(browser.opened[1]!, ADA));
    other.searchParams.set("request", "another");
    browser.back(other.href);
    await vi.waitFor(() => expect(signingIn(hosted)).toEqual({ state: "failed", error: "That sign-in wasn't this app's. Try again." }));
    expect(device.stored).toBeNull();
  });

  it("says a device with no browser can't sign in", async () => {
    const { hosted } = await host({ browser: undefined });
    await hosted.account.signIn();
    expect(signingIn(hosted)).toEqual({ state: "failed", error: "This device can't open OpenOrc's sign-in page." });
  });

  it("never puts the verifier, the code or the token in a status, a push, a log line or what is kept", async () => {
    const { hosted, browser, seen, sent } = await host();
    const said: unknown[] = [];
    await hosted.account.signIn();
    said.push(hosted.account.status());
    const returnTo = stand.signInPage(browser.opened[0]!, ADA);
    browser.back(returnTo);
    await vi.waitFor(() => expect(hosted.account.status().state).toBe("signed-in"));
    said.push(hosted.account.status());
    const finish = JSON.parse(sent.find((body) => body.includes("verifier"))!) as { code: string; verifier: string };
    const secrets = [finish.code, finish.verifier, storedToken(device)];
    expect(new URL(returnTo).searchParams.get("code")).toBe(finish.code);
    const everything = JSON.stringify({ said, logs: seen.logs, pushes: seen.pushes, kept: device.kept, opened: browser.opened });
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });
});

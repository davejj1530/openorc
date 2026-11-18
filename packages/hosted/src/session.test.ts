import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted } from "./index.js";
import { OutOfReach, Refused, Session, Unreadable } from "./session.js";
import { hostDeps, newDevice, signInAs, storedToken, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { ROUTES } from "./wire.js";

const EMAIL = "ada@example.com";

let stand: StandIn;
let device: Device;
const sessions: Session[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await stand.close();
});

function session(overrides: Parameters<typeof hostDeps>[2] = {}) {
  const { deps, seen } = hostDeps(stand, device, overrides);
  const made = new Session(deps);
  sessions.push(made);
  return { session: made, seen };
}

/** The token the server gives for `email` once a browser sign-in for it was approved, as an app's finish reads it. */
async function tokenFor(email: string): Promise<string> {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const post = async (path: string, body: unknown) =>
    (await (await fetch(new URL(path, stand.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, string>;
  const { request, url } = await post("/app-sign-in/start", { port: 40_001, challenge, device: "OpenOrc on this Mac" });
  const code = new URL(stand.signInPage(url!, email)).searchParams.get("code");
  return (await post("/app-sign-in/finish", { request, code, verifier })).token!;
}

async function signedIn(made: Session) {
  await made.adopt(await tokenFor(EMAIL));
}

const live = (made: Session) => vi.waitFor(() => expect(made.state).toMatchObject({ signedIn: true, reach: "live" }));

describe("the session", () => {
  it("sends the token as a bearer on every request after sign-in", async () => {
    const { session: made } = session();
    await signedIn(made);
    await made.request(ROUTES.billing);
    await made.request(ROUTES.billing);
    const billing = stand.requests.filter((request) => request.path === "/billing");
    expect(billing).toHaveLength(2);
    expect(billing.every((request) => request.authorized)).toBe(true);
  });

  it("asks the server who a new token is for, and saves it before it holds it", async () => {
    let release = () => {};
    const saved = new Promise<void>((resolve) => (release = resolve));
    const { session: made } = session({
      session: {
        load: async () => device.stored,
        save: async (value) => {
          await saved;
          device.stored = value;
        },
      },
    });
    const signing = made.adopt(await tokenFor(EMAIL));
    await vi.waitFor(() => expect(stand.requests.at(-1)).toEqual({ method: "GET", path: "/api/auth/get-session", authorized: true }));
    expect(made.state).toEqual({ signedIn: false, ended: false });
    release();
    await signing;
    expect(storedToken(device)).toMatch(/^[^.]+\.[^.]+$/);
    expect(made.state).toMatchObject({ signedIn: true, email: EMAIL });
    await made.request(ROUTES.billing);
    expect(stand.requests.at(-1)).toEqual({ method: "GET", path: "/billing", authorized: true });
  });

  it("leaves the app signed out when the token cannot be saved", async () => {
    const { session: made, seen } = session({
      session: {
        load: async () => null,
        save: async () => {
          throw new Error("Cannot access protected storage.");
        },
      },
    });
    await expect(made.adopt(await tokenFor(EMAIL))).rejects.toThrow("Cannot access protected storage.");
    expect(made.state).toEqual({ signedIn: false, ended: false });
    expect(seen.sockets).toEqual([]);
    await expect(made.request(ROUTES.billing)).rejects.toThrow("Sign in to OpenOrc first.");
  });

  it("discards the session when sign-in is canceled while protected storage is saving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let wanted = true;
    let saving = false;
    const { session: made, seen } = session({
      session: {
        load: async () => null,
        save: async (value) => {
          saving = true;
          await gate;
          device.stored = value;
        },
      },
    });
    const token = await tokenFor(EMAIL);
    const adopting = made.adopt(token, () => wanted);
    await vi.waitFor(() => expect(saving).toBe(true));
    wanted = false;
    release();
    await adopting;
    expect(device.stored).toBeNull();
    expect(made.state.signedIn).toBe(false);
    expect(seen.sockets).toEqual([]);
    await vi.waitFor(() => expect(stand.requests.some((request) => request.path === "/api/auth/sign-out")).toBe(true));
    expect(await (await fetch(new URL("/api/auth/get-session", stand.url), { headers: { authorization: `Bearer ${token}` } })).json()).toBeNull();
  });

  it("forgets the token on a 401, says the session ended, and closes the socket", async () => {
    const { session: made, seen } = session();
    await signedIn(made);
    await live(made);
    stand.revoke();
    const refusal = await made.request(ROUTES.billing).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Refused);
    expect((refusal as Refused).message).toBe("Your OpenOrc session ended. Sign in again.");
    expect(made.state).toEqual({ signedIn: false, ended: true });
    expect(device.stored).toBeNull();
    expect(seen.sockets.map((socket) => socket.closed)).toEqual([true]);
  });

  it("rejects a network failure as out of reach and keeps the token", async () => {
    const { session: made } = session();
    await signedIn(made);
    const token = storedToken(device);
    await stand.down();
    await expect(made.request(ROUTES.billing)).rejects.toBeInstanceOf(OutOfReach);
    expect(storedToken(device)).toBe(token);
    expect(made.state).toMatchObject({ signedIn: true, email: EMAIL });
  });

  it("waits as long as a route says its server may take, and the session's own time for any other", async () => {
    const { session: made } = session();
    await signedIn(made);
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    await made.request(ROUTES.billing);
    // A write waits on the thread's machine, which the server gives 90 s and may first wake.
    await made.request(ROUTES.writeFile("thread-1"), { id: "00000000-0000-4000-8000-000000000001", path: "NOTE.md", text: "one", expected: { kind: "absent" } }).catch(() => undefined);
    expect(deadlines.mock.calls.map(([ms]) => ms)).toEqual([30_000, 100_000]);
  });

  it("rejects a reply that does not parse as unreadable", async () => {
    const { session: made } = session({
      fetch: async (input, init) => (new URL(String(input)).pathname === "/billing" ? new Response(JSON.stringify({ pro: "yes" }), { status: 200 }) : fetch(input, init)),
    });
    await signedIn(made);
    await expect(made.request(ROUTES.billing)).rejects.toBeInstanceOf(Unreadable);
    expect(made.state).toMatchObject({ signedIn: true });
  });

  it("is live exactly while the socket is up, and a drop shorter than two seconds changes nothing", async () => {
    const { session: made } = session();
    const reaches: string[] = [];
    made.onChange(() => {
      const state = made.state;
      reaches.push(state.signedIn ? state.reach : "signed-out");
    });
    await signedIn(made);
    await live(made);
    await stand.down();
    await stand.up();
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(made.state).toMatchObject({ reach: "live" });
    expect(reaches.filter((reach) => reach !== "live")).toEqual(["offline"]);
    await stand.down();
    await vi.waitFor(() => expect(made.state).toMatchObject({ reach: "offline" }), { timeout: 3_000 });
    await stand.up();
    await live(made);
  });

  it("signs out when the server refuses the socket, the same as a 401", async () => {
    device.stored = JSON.stringify({ token: "forged.token", email: EMAIL });
    const { session: made, seen } = session();
    await made.start();
    await vi.waitFor(() => expect(made.state).toEqual({ signedIn: false, ended: true }));
    expect(device.stored).toBeNull();
    expect(seen.sockets.map((socket) => socket.closed)).toEqual([true]);
  });

  it("never puts the token in an error, a log line or a status", async () => {
    const { deps, seen, browser } = hostDeps(stand, device);
    const hosted = createHosted(deps);
    const said: unknown[] = [];
    const collect = async (work: () => Promise<unknown>) => said.push(await work().catch((error: unknown) => (error instanceof Error ? error.message : error)));
    await hosted.start();
    await signInAs(hosted, browser, EMAIL);
    const token = storedToken(device);
    said.push(hosted.account.status());
    await stand.down();
    await collect(() => hosted.account.setSandbox(null));
    said.push(hosted.account.status());
    stand.revoke();
    await stand.up();
    await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-out", ended: true }), { timeout: 5_000 });
    said.push(hosted.account.status());
    hosted.close();
    const everything = JSON.stringify({ said, logs: seen.logs, pushes: seen.pushes, kept: device.kept });
    expect(token.length).toBeGreaterThan(20);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split(".")[0]);
    expect(seen.logs).toContain("OpenOrc Cloud ended the session");
  });
});

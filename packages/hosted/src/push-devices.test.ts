import { createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import type { StandInApnsPayload, StandInNotice } from "./testing/stand-in-push.js";

/*
 * A signed-in phone registers for alerts about its person's cloud threads under the public half of a key it made for
 * the server, and the server seals each alert for it with its own key, as a Mac seals its own: Apple carries fixed words
 * and an envelope only that phone opens.
 */
const SELF = "member@example.com";
const OTHER = "other@example.com";
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const hosts: Hosted[] = [];
let stand: StandIn;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((hosted) => hosted.close());
  await stand.close();
});

async function app(email: string, inUse?: HostedDeps["inUse"]): Promise<{ hosted: Hosted; device: Device }> {
  const device = newDevice();
  const { deps, browser } = hostDeps(stand, device, inUse ? { inUse } : {});
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.account.status()).toMatchObject({ state: "signed-in", reach: "live" }));
  return { hosted, device };
}

/** A phone's key for the server, its id the public half, and an APNs token. */
function phoneKey(): { id: string; privateKey: KeyObject; token: string } {
  const pair = generateKeyPairSync("x25519");
  return { id: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"), privateKey: pair.privateKey, token: randomBytes(32).toString("hex") };
}
const registration = (token: string, alerts: "all" | "needs-you" = "all") => ({ token, environment: "production" as const, alerts, sound: true });

/** The alert as the phone's extension opens it, written out apart from the stand-in's sealing; null when it is not this phone's. */
function opened(payload: StandInApnsPayload, phone: { id: string; privateKey: KeyObject }): Record<string, unknown> | null {
  const sender = Buffer.from(payload.o.m, "base64url");
  const secret = diffieHellman({ privateKey: phone.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, sender]), format: "der", type: "spki" }) });
  const prk = createHmac("sha256", "openorc push v1").update(secret).digest();
  const seal = createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("seal"), sender, Buffer.from(phone.id, "base64url"), Uint8Array.of(1)]))
    .digest();
  const sealed = Buffer.from(payload.o.c, "base64url");
  const open = createDecipheriv("aes-256-gcm", seal, Buffer.from(payload.o.n, "base64url"), { authTagLength: 16 });
  open.setAAD(Buffer.from(`openorc push v1.${payload.o.m}`));
  open.setAuthTag(sealed.subarray(-16));
  try {
    return JSON.parse(Buffer.concat([open.update(sealed.subarray(0, -16)), open.final()]).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ask: StandInNotice = { kind: "approval", threadId: "thread-1", title: "Fix the build", body: "Claude wants to use Bash: ls", approval: { runId: "hosted:thread-1", approvalId: "ask-1" } };
const finished = (threadId: string): StandInNotice => ({ kind: "finished", threadId, title: "Fix the build", body: "All green now." });
const sentTo = (token: string) => stand.push.pushed.filter((pushed) => pushed.token === token).map((pushed) => pushed.payload);

it("registers a phone under its own key and seals each alert for it alone, once the server can send", async () => {
  const { hosted } = await app(SELF);
  const phone = phoneKey();
  expect(await hosted.account.registerDevice(phone.id, registration(phone.token))).toEqual({ sender: "no-key", publicKey: stand.push.publicKey });
  await stand.push.alert(SELF, ask);
  expect(stand.push.pushed, "a server with no key for Apple sends nothing").toEqual([]);

  stand.push.sender = "ready";
  expect(await hosted.account.registerDevice(phone.id, registration(phone.token))).toMatchObject({ sender: "ready" });
  const other = await app(OTHER);
  const stranger = phoneKey();
  await other.hosted.account.registerDevice(stranger.id, registration(stranger.token));
  await stand.push.alert(SELF, ask);
  const [payload, ...more] = sentTo(phone.token);
  expect(more).toEqual([]);
  expect(payload!.aps).toEqual({ alert: { body: "New activity in OpenOrc Cloud" }, "mutable-content": 1, sound: "default" });
  expect(payload!.o.m).toBe(stand.push.publicKey);
  expect(opened(payload!, phone)).toEqual({ id: expect.any(String), ...ask });
  expect(opened(payload!, stranger), "another phone can't open it").toBeNull();
  expect(sentTo(stranger.token), "another person's phone hears nothing").toEqual([]);
});

it("keeps a phone only under its own key, one row a token, and while its session is signed in", async () => {
  const { hosted, device } = await app(SELF);
  const phone = phoneKey();
  const token = (JSON.parse(device.stored ?? "{}") as { token: string }).token;
  const put = (body: unknown, bearer: string | null = token) =>
    fetch(`${stand.url}/devices/${phone.id}`, { method: "PUT", headers: { "content-type": "application/json", ...(bearer && { authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body) });
  const refusal = await put({ ...registration(phone.token), publicKey: phoneKey().id });
  expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({ message: "A phone registers under its own key." });
  expect((await put({ ...registration(phone.token), publicKey: phone.id }, null)).status).toBe(401);
  expect(stand.push.devices(SELF)).toEqual([]);

  // The same phone made a new key: only its new row is kept.
  await hosted.account.registerDevice(phone.id, registration(phone.token));
  const rekeyed = phoneKey();
  await hosted.account.registerDevice(rekeyed.id, registration(phone.token, "needs-you"));
  expect(stand.push.devices(SELF)).toEqual([{ id: rekeyed.id, ...registration(phone.token, "needs-you") }]);
  await hosted.account.removeDevice(rekeyed.id);
  await hosted.account.removeDevice(rekeyed.id);
  expect(stand.push.devices(SELF)).toEqual([]);

  await hosted.account.registerDevice(phone.id, registration(phone.token));
  await hosted.account.signOut();
  await vi.waitFor(() => expect(stand.push.devices(SELF), "a signed-out session's phone is not alerted").toEqual([]));
});

it("plans each alert as a Mac plans its own", async () => {
  stand.push.sender = "ready";
  const { hosted } = await app(SELF);
  const all = phoneKey();
  const asks = phoneKey();
  await hosted.account.registerDevice(all.id, registration(all.token));
  await hosted.account.registerDevice(asks.id, registration(asks.token, "needs-you"));
  await stand.push.alert(SELF, finished("thread-2"));
  expect(sentTo(asks.token), "a phone that takes only asks hears no outcome").toEqual([]);
  expect(sentTo(all.token).map((payload) => payload.aps.sound)).toEqual(["default"]);
  // A second alert about the thread soon after a ring comes quietly.
  await stand.push.alert(SELF, finished("thread-2"));
  expect(sentTo(all.token).at(-1)!.aps).toMatchObject({ "interruption-level": "passive" });

  // At a computer, an outcome is already on screen and an ask comes quietly.
  await app(SELF, async () => true);
  const before = stand.push.pushed.length;
  await stand.push.alert(SELF, finished("thread-3"));
  expect(stand.push.pushed.length).toBe(before);
  await stand.push.alert(SELF, { ...ask, threadId: "thread-3" });
  expect(sentTo(asks.token).map((payload) => payload.aps)).toEqual([{ alert: { body: "New activity in OpenOrc Cloud" }, "mutable-content": 1, "interruption-level": "passive" }]);
});

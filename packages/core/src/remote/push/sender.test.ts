import { beforeEach, describe, expect, it, vi } from "vitest";
import { Db, remoteDevices, remotePushTargets } from "@openorc/db";
import { collapseId, openPush, pushKeys, type KeyPair, type PushEnvelope } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import type { PushAlerts, PushEnvironment, RemotePush } from "@openorc/protocol";
import type { PushDelivery, PushOutcome, PushRoute } from "./route.js";
import { PushSender } from "./sender.js";

type Notice = Extract<RemotePush, { type: "notify" }>;

class RecordingRoute implements PushRoute {
  readonly sent: PushDelivery[] = [];
  readonly outcomes: PushOutcome[] = [];
  send = vi.fn(async (delivery: PushDelivery): Promise<PushOutcome> => {
    this.sent.push(delivery);
    return this.outcomes.shift() ?? { kind: "sent" };
  });
  close() {}
}

interface Phone {
  deviceId: string;
  keys: KeyPair;
  token: string;
}

const START = Date.UTC(2026, 9, 24, 12);
let db: Db,
  mac: KeyPair,
  route: RecordingRoute,
  clock: number,
  inUse: () => Promise<boolean>,
  warnings: string[],
  changed: ReturnType<typeof vi.fn<(what: "phones" | "sender") => void>>,
  sender: PushSender;
let keyAdded: boolean, routeAsked: ReturnType<typeof vi.fn<() => Promise<PushRoute | null>>>;

beforeEach(() => {
  db = Db.memory();
  mac = nodeCrypto.generateKeyPair();
  route = new RecordingRoute();
  clock = START;
  inUse = async () => false;
  warnings = [];
  changed = vi.fn<(what: "phones" | "sender") => void>();
  keyAdded = true;
  routeAsked = vi.fn(async () => (keyAdded ? route : null));
  sender = new PushSender({
    db,
    route: routeAsked,
    presence: () => inUse(),
    log: { info() {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    changed,
    now: () => clock,
  });
});

let phoneCount = 0;
function phone(alerts: PushAlerts = "all", sound = true, environment: PushEnvironment = "sandbox"): Phone {
  const keys = nodeCrypto.generateKeyPair();
  // Paired in order, so they are sent to in order.
  const device = remoteDevices.upsert(db, { publicKey: keys.publicKey, name: `Phone ${++phoneCount}`, at: START - 10_000 + phoneCount });
  const token = Buffer.from(nodeCrypto.randomBytes(32)).toString("hex");
  remotePushTargets.set(db, device.id, { token, environment, alerts, sound }, clock);
  return { deviceId: device.id, keys, token };
}

function notice(patch: Partial<Notice> = {}): Notice {
  return { type: "notify", id: "notice-1", kind: "finished", threadId: "thread-1", taskId: null, title: "Fix the login bug", body: "Done. The tests pass.", ...patch };
}

const payloadOf = (delivery: PushDelivery) => JSON.parse(delivery.payload) as { aps: Record<string, unknown>; o: PushEnvelope };
const sealKey = (to: Phone) => pushKeys(nodeCrypto, to.keys, mac.publicKey, "phone").seal;
const open = (delivery: PushDelivery, to: Phone) => openPush(nodeCrypto, sealKey(to), payloadOf(delivery).o);
const sentTo = (to: Phone) => route.sent.filter((delivery) => delivery.token === to.token);

const send = (sent: Notice) => sender.send(sent, mac);

describe("the push sender", () => {
  it("seals an approval for each phone with its ids, so only that phone can read it", async () => {
    const [first, second] = [phone(), phone("needs-you", false)];
    await send(notice({ kind: "approval", title: "Release", body: "Codex wants to run git push", runId: "run-1", approvalId: "approval-1" }));

    expect(route.sent).toHaveLength(2);
    const [toFirst, toSecond] = [sentTo(first)[0]!, sentTo(second)[0]!];
    const read = { id: "notice-1", kind: "approval", threadId: "thread-1", title: "Release", body: "Codex wants to run git push", approval: { runId: "run-1", approvalId: "approval-1" } };
    expect(open(toFirst, first)).toEqual(read);
    expect(open(toSecond, second)).toEqual(read);
    expect(openPush(nodeCrypto, sealKey(second), payloadOf(toFirst).o)).toBeNull();

    expect(toFirst).toMatchObject({ environment: "sandbox", priority: 10, expiresAt: START / 1000 + 12 * 3600 });
    expect(payloadOf(toFirst).aps).toEqual({ alert: { body: "New activity on your Mac" }, "mutable-content": 1, sound: "default" });
    expect(payloadOf(toSecond).aps).toEqual({ alert: { body: "New activity on your Mac" }, "mutable-content": 1 });
    expect(toFirst.payload).not.toMatch(/Release|git push|thread-1|run-1|approval-1/);
    expect(toFirst.collapseId).toBe(collapseId(nodeCrypto, pushKeys(nodeCrypto, mac, first.keys.publicKey, "mac").collapse, "thread-1"));
    expect(toFirst.collapseId).not.toBe(toSecond.collapseId);
  });

  it("gives a question no ids to answer it with, and an outcome only to phones that take everything", async () => {
    const [all, needsYou] = [phone(), phone("needs-you")];
    await send(notice({ kind: "question", runId: "run-1", approvalId: "question-1" }));
    expect(open(sentTo(all)[0]!, all)).not.toHaveProperty("approval");
    clock += 61_000;
    await send(notice({ kind: "finished", threadId: "thread-2" }));
    expect([sentTo(all).length, sentTo(needsYou).length]).toEqual([2, 1]);
  });

  it("sends nothing for a notice without a thread, and asks nothing without a push key", async () => {
    phone();
    const presence = vi.fn(async () => false);
    inUse = presence;
    await send(notice({ threadId: null, taskId: "task-1" }));
    keyAdded = false;
    await send(notice());
    expect(route.send).not.toHaveBeenCalled();
    expect(presence).not.toHaveBeenCalled();
  });

  it("rings once a minute per thread and phone, then replaces the alert quietly", async () => {
    const to = phone();
    await send(notice({ kind: "approval", runId: "r", approvalId: "a" }));
    clock += 10_000;
    await send(notice({ id: "notice-2", kind: "finished" }));
    await send(notice({ id: "notice-3", kind: "finished", threadId: "thread-2" }));
    clock += 51_000;
    await send(notice({ id: "notice-4", kind: "error" }));

    const [approval, quiet, otherThread, later] = sentTo(to);
    expect(quiet).toMatchObject({ priority: 5, collapseId: approval!.collapseId });
    expect(payloadOf(quiet!).aps).toEqual({ alert: { body: "New activity on your Mac" }, "mutable-content": 1, "interruption-level": "passive" });
    expect(otherThread).toMatchObject({ priority: 10 });
    expect(later).toMatchObject({ priority: 10, collapseId: approval!.collapseId });
  });

  it("lets the next alert ring when APNs never took the last ring", async () => {
    const to = phone();
    route.outcomes.push({ kind: "failed", reason: "ServiceUnavailable" });
    await send(notice({ kind: "approval", runId: "r", approvalId: "a" }));
    clock += 300;
    await send(notice({ id: "notice-2", kind: "approval", runId: "r", approvalId: "b" }));
    expect(sentTo(to).map((delivery) => delivery.priority)).toEqual([10, 10]);
    expect(payloadOf(sentTo(to)[1]!).aps).toEqual({ alert: { body: "New activity on your Mac" }, "mutable-content": 1, sound: "default" });
  });

  it("sends nothing still waiting once phone access stops, and asks for no route to send it with", async () => {
    phone();
    phone();
    let release: () => void = () => undefined;
    route.send.mockImplementationOnce(async (delivery) => {
      route.sent.push(delivery);
      await new Promise<void>((resolve) => (release = resolve));
      return { kind: "sent" };
    });
    void sender.send(notice(), mac);
    const second = sender.send(notice({ id: "notice-2", threadId: "thread-2" }), mac);
    await vi.waitFor(() => expect(route.sent).toHaveLength(1));
    sender.close();
    release();
    await second;
    expect(route.sent).toHaveLength(1);
    expect(routeAsked).toHaveBeenCalledTimes(1);
    expect(await sender.test(mac, "Studio")).toEqual({ sent: 2, failed: 0, problem: null });
  });

  it("holds outcomes back while the Mac is in use and lets approvals wait quietly", async () => {
    const to = phone();
    inUse = async () => true;
    await send(notice({ kind: "finished" }));
    await send(notice({ kind: "approval", runId: "r", approvalId: "a" }));
    expect(sentTo(to).map((delivery) => delivery.priority)).toEqual([5]);
  });

  it("reads the Mac as away when presence is slower than 250 ms or fails", async () => {
    const to = phone();
    inUse = () => new Promise((resolve) => setTimeout(() => resolve(true), 400));
    const started = Date.now();
    await send(notice({ kind: "finished" }));
    expect(Date.now() - started).toBeLessThan(400);
    inUse = async () => Promise.reject(new Error("main is gone"));
    await send(notice({ kind: "finished", threadId: "thread-2" }));
    expect(sentTo(to).map((delivery) => delivery.priority)).toEqual([10, 10]);
  });

  it("clips long text and fits the worst case into 4096 bytes", async () => {
    const to = phone();
    await send(notice({ title: "👩🏽‍💻".repeat(400), body: '\u0001"'.repeat(3000) }));
    await send(notice({ id: "notice-2", threadId: "thread-2", title: "Short", body: "Just right." }));

    const [worst, plain] = sentTo(to);
    expect(Buffer.byteLength(worst!.payload)).toBeLessThanOrEqual(4096);
    const opened = open(worst!, to)!;
    expect(Array.from(opened.title)).toHaveLength(120);
    expect(opened.title.endsWith("…")).toBe(true);
    expect(opened.body.endsWith("…")).toBe(true);
    expect(Array.from(opened.body).length).toBeLessThan(600);
    expect(open(plain!, to)).toMatchObject({ title: "Short", body: "Just right." });
  });

  it("drops a notice that cannot fit, and says so without its text", async () => {
    phone();
    await send(notice({ id: "x".repeat(5000), title: "Secret title" }));
    expect(route.send).not.toHaveBeenCalled();
    expect(warnings).toEqual(["A phone alert was too large to send."]);
  });

  it("forgets a token APNs no longer knows, and keeps the rest", async () => {
    const [gone, kept] = [phone(), phone()];
    route.outcomes.push({ kind: "gone", reason: "Unregistered" });
    await send(notice());
    expect(remotePushTargets.recipients(db).map((recipient) => recipient.deviceId)).toEqual([kept.deviceId]);
    expect(changed.mock.calls).toEqual([["phones"]]);
    expect(gone.deviceId).not.toBe(kept.deviceId);
  });

  it("keeps Apple's refusal as the problem until a send succeeds, says so once, and logs a failure", async () => {
    phone();
    route.outcomes.push({ kind: "refused", reason: "InvalidProviderToken" }, { kind: "refused", reason: "InvalidProviderToken" });
    await send(notice());
    clock += 61_000;
    await send(notice());
    expect(sender.problem).toEqual({ reason: "InvalidProviderToken", environment: "sandbox" });
    expect(changed.mock.calls).toEqual([["sender"]]);
    route.outcomes.push({ kind: "failed", reason: "ServiceUnavailable" });
    clock += 61_000;
    await send(notice());
    expect(sender.problem).toEqual({ reason: "InvalidProviderToken", environment: "sandbox" });
    expect(warnings).toEqual(["APNs did not take a phone alert: ServiceUnavailable"]);
    clock += 61_000;
    await send(notice());
    expect(sender.problem).toBeNull();
    expect(changed.mock.calls).toEqual([["sender"], ["sender"]]);
    sender.close();
  });

  it("keeps a refusal to its own environment, so phones Apple still takes alerts for never hear it", async () => {
    const [xcodeBuild, storeBuild] = [phone(), phone("all", true, "production")];
    route.send.mockImplementation(async (delivery) => {
      route.sent.push(delivery);
      return delivery.environment === "production" ? { kind: "refused", reason: "BadEnvironmentKeyIdInToken" } : { kind: "sent" };
    });
    for (const id of ["notice-1", "notice-2", "notice-3"]) {
      clock += 61_000;
      await send(notice({ id }));
    }
    expect([sentTo(xcodeBuild).length, sentTo(storeBuild).length]).toEqual([3, 3]);
    expect(changed.mock.calls).toEqual([["sender"]]);
    expect(sender.problem).toEqual({ reason: "BadEnvironmentKeyIdInToken", environment: "production" });
    expect([sender.refuses("sandbox"), sender.refuses("production")]).toEqual([false, true]);
    sender.keyChanged();
    expect([sender.problem, sender.refuses("production")]).toEqual([null, false]);
  });

  it("seals nothing for a phone removed or turned off while an earlier phone's alert was on its way, and the newest registration for the rest", async () => {
    const [first, removed, off, moved] = [phone(), phone(), phone(), phone()];
    const movedTo = Buffer.from(nodeCrypto.randomBytes(32)).toString("hex");
    route.send.mockImplementationOnce(async (delivery) => {
      route.sent.push(delivery);
      remoteDevices.remove(db, removed.deviceId);
      remotePushTargets.remove(db, off.deviceId);
      remotePushTargets.set(db, moved.deviceId, { token: movedTo, environment: "sandbox", alerts: "needs-you", sound: false }, clock);
      return { kind: "sent" };
    });
    await send(notice({ kind: "approval", runId: "r", approvalId: "a" }));
    expect(route.sent.map((delivery) => delivery.token)).toEqual([first.token, movedTo]);
    expect(payloadOf(route.sent[1]!).aps).not.toHaveProperty("sound");
  });

  it("never throws into the core", async () => {
    phone();
    route.send.mockRejectedValueOnce(new Error("socket hang up"));
    let sending: Promise<void> | undefined;
    expect(() => (sending = sender.send(notice(), mac))).not.toThrow();
    await expect(sending).resolves.toBeUndefined();
    expect(warnings).toEqual(["Phone alerts failed: socket hang up"]);
  });

  it("sends the test notice to every phone, at the Mac too, and says how many took it", async () => {
    const [all, needsYou] = [phone(), phone("needs-you", false)];
    inUse = async () => true;
    expect(await sender.test(mac, "Studio")).toEqual({ sent: 2, failed: 0, problem: null });
    const read = { kind: "test", threadId: null, title: "OpenOrc", body: "Notifications from Studio reach this iPhone." };
    expect(open(sentTo(all)[0]!, all)).toMatchObject(read);
    expect(open(sentTo(needsYou)[0]!, needsYou)).toMatchObject(read);
    expect(sentTo(needsYou)[0]).toMatchObject({ priority: 10, collapseId: collapseId(nodeCrypto, pushKeys(nodeCrypto, mac, needsYou.keys.publicKey, "mac").collapse, null) });

    route.outcomes.push({ kind: "refused", reason: "BadEnvironmentKeyIdInToken" });
    expect(await sender.test(mac, "Studio")).toEqual({ sent: 1, failed: 0, problem: { reason: "BadEnvironmentKeyIdInToken", environment: "sandbox" } });
    route.outcomes.push({ kind: "failed", reason: "APNs did not answer in time." }, { kind: "failed", reason: "ServiceUnavailable" });
    expect(await sender.test(mac, "Studio")).toEqual({ sent: 0, failed: 2, problem: null });
    keyAdded = false;
    expect(await sender.test(mac, "Studio")).toEqual({ sent: 0, failed: 0, problem: null });
  });
});

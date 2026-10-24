import { describe, expect, it } from "vitest";
import { acceptLink, connectLink, type Admission, type MacSession, type PhoneSession } from "./connect.js";
import type { MacMessage, PhoneMessage } from "./messages.js";
import { nodeCrypto } from "./node.js";
import { LinkCloseCode } from "./session.js";
import { socketPair, type Tap } from "./test-fixtures/socket-pair.js";

const macKey = nodeCrypto.generateKeyPair();
const deviceKey = nodeCrypto.generateKeyPair();
const admitted: Admission<string> = { ok: true, hello: { mac: { name: "Studio Mac" }, deviceId: "device-1", routes: [{ kind: "lan", host: "studio.local", port: 47820 }] }, value: "admitted" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(options: { admit?: () => Admission<string>; pinned?: Uint8Array } = {}) {
  const sockets = socketPair();
  const accepted = acceptLink({ socket: sockets.mac, crypto: nodeCrypto, local: macKey, admit: options.admit ?? (() => admitted) });
  const connected = await connectLink({
    socket: sockets.phone,
    crypto: nodeCrypto,
    device: deviceKey,
    macKey: options.pinned ?? macKey.publicKey,
    hello: { device: { name: "Phone" } },
    timeoutMs: 1000,
  });
  return { ...sockets, connected, accepted: await accepted };
}

async function sessions() {
  const opened = await open();
  if (!opened.connected.ok || !opened.accepted) throw new Error("no session");
  const macSession = opened.accepted.session;
  // The phone speaks first, so its ping comes before anything a test sends.
  expect(await new Promise((resolve) => macSession.onMessage(resolve))).toEqual({ t: "ping", id: 0 });
  return { ...opened, phoneSession: opened.connected.session, macSession };
}

function collect<T>(session: { onMessage(listener: (message: T) => void): unknown }): T[] {
  const received: T[] = [];
  session.onMessage((message) => received.push(message));
  return received;
}

function closeOf(session: PhoneSession | MacSession): Promise<number> {
  return new Promise((resolve) => session.onClose((code) => resolve(code)));
}

describe("link sessions", () => {
  it("opens a session in which each end knows the other's key and hears the Mac's hello", async () => {
    const { connected, accepted } = await open();
    expect(connected).toMatchObject({ ok: true, hello: { t: "hello", mac: { name: "Studio Mac" }, deviceId: "device-1", routes: admitted.ok ? admitted.hello.routes : [] } });
    expect(accepted?.value).toBe("admitted");
    expect(accepted?.session.remoteStatic).toEqual(deviceKey.publicKey);
  });

  it("has the phone speak first, since a replayed first handshake message is answered too", async () => {
    const sockets = socketPair();
    const heard = acceptLink({ socket: sockets.mac, crypto: nodeCrypto, local: macKey, admit: () => admitted }).then(
      (accepted) => new Promise<PhoneMessage>((resolve) => accepted?.session.onMessage(resolve)),
    );
    await connectLink({ socket: sockets.phone, crypto: nodeCrypto, device: deviceKey, macKey: macKey.publicKey, hello: { device: { name: "Phone" } }, timeoutMs: 1000 });
    expect(await heard).toEqual({ t: "ping", id: 0 });
  });

  it("keeps what the Mac sends right behind its answer until the phone listens", async () => {
    const sockets = socketPair();
    // The answer and the next record arrive in one read, before the phone's caller has had a turn.
    let answer: Uint8Array | null = null;
    sockets.mac.tap = (data) => {
      if (answer) return [answer, data];
      answer = data;
      return [];
    };
    const accepted = acceptLink({ socket: sockets.mac, crypto: nodeCrypto, local: macKey, admit: () => admitted });
    const connecting = connectLink({ socket: sockets.phone, crypto: nodeCrypto, device: deviceKey, macKey: macKey.publicKey, hello: { device: { name: "Phone" } }, timeoutMs: 1000 });
    (await accepted)?.session.send({ t: "closing", reason: "removed" });
    const connected = await connecting;
    if (!connected.ok) throw new Error("no session");
    await tick();
    const first = collect<MacMessage>(connected.session);
    const second = collect<MacMessage>(connected.session);
    expect(first).toEqual([{ t: "closing", reason: "removed" }]);
    expect(second).toEqual([]);
  });

  it("delivers messages in order and batches one tick's messages into one record", async () => {
    const { phone, phoneSession, macSession } = await sessions();
    const atMac = collect<PhoneMessage>(macSession);
    const atPhone = collect<MacMessage>(phoneSession);
    const before = phone.sent.length;
    phoneSession.send({ t: "rpc", id: 1, method: "threads.list", params: {} });
    phoneSession.send({ t: "interest", runIds: ["run-1"] });
    phoneSession.send({ t: "ping", id: 2 });
    await tick();
    expect(phone.sent.length - before).toBe(1);
    expect(atMac).toEqual([
      { t: "rpc", id: 1, method: "threads.list", params: {} },
      { t: "interest", runIds: ["run-1"] },
      { t: "ping", id: 2 },
    ]);
    macSession.send({ t: "rpc.result", id: 1, result: [] });
    await tick();
    expect(atPhone).toEqual([{ t: "rpc.result", id: 1, result: [] }]);
  });

  it("tells a refused phone why, in an answer only the pinned Mac could have sent", async () => {
    const { connected, accepted, phone } = await open({ admit: () => ({ ok: false, reason: "unpaired" }) });
    expect(connected).toEqual({ ok: false, refused: "unpaired" });
    expect(accepted).toBeNull();
    expect(phone.closedWith?.code).toBe(LinkCloseCode.refused);
  });

  it("gives a phone that pinned another key no session and no answer", async () => {
    const { connected, accepted } = await open({ pinned: nodeCrypto.generateKeyPair().publicKey });
    expect(connected).toMatchObject({ ok: false, refused: null });
    expect(accepted).toBeNull();
  });

  const taps: Array<[string, () => Tap]> = [
    [
      "tampered",
      () => (data) => {
        const copy = Uint8Array.from(data);
        copy[copy.length - 1]! ^= 1;
        return [copy];
      },
    ],
    ["replayed", () => (data) => [data, data]],
    [
      "reordered",
      () => {
        let held: Uint8Array | null = null;
        return (data) => {
          if (!held) {
            held = data;
            return [];
          }
          const out = [data, held];
          held = null;
          return out;
        };
      },
    ],
  ];

  it.each(taps)("ends the session on a %s record", async (_name, makeTap) => {
    const { phone, phoneSession, macSession } = await sessions();
    const atMac = collect<PhoneMessage>(macSession);
    const macClosed = closeOf(macSession);
    const phoneClosed = closeOf(phoneSession);
    phone.tap = makeTap();
    phoneSession.send({ t: "ping", id: 1 });
    await tick();
    phoneSession.send({ t: "ping", id: 2 });
    expect(await macClosed).toBe(LinkCloseCode.protocol);
    expect(await phoneClosed).toBe(LinkCloseCode.protocol);
    expect(atMac.length).toBeLessThanOrEqual(1);
    expect(macSession.closed && phoneSession.closed).toBe(true);
  });

  it("carries a message larger than one record whole", async () => {
    const { phoneSession, macSession } = await sessions();
    const atMac = collect<PhoneMessage>(macSession);
    const text = "x".repeat(300_000);
    phoneSession.send({ t: "rpc", id: 9, method: "attachments.save", params: { dataBase64: text } });
    await tick();
    expect(atMac).toEqual([{ t: "rpc", id: 9, method: "attachments.save", params: { dataBase64: text } }]);
  });

  it("streams 5 MB of bytes without holding back a message sent while it streams", async () => {
    const { phoneSession, macSession } = await sessions();
    const image = nodeCrypto.randomBytes(5 * 1024 * 1024);
    const events: Array<{ kind: "chunk"; chunk: Uint8Array; end: boolean } | { kind: "message"; message: MacMessage }> = [];
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnd = resolve));
    let sentBeforeFirstChunk: boolean | null = null;
    let sent = false;
    phoneSession.onBytes((stream, chunk, end) => {
      expect(stream).toBe(7);
      sentBeforeFirstChunk ??= sent;
      events.push({ kind: "chunk", chunk: Uint8Array.from(chunk), end });
      if (end) resolveEnd();
    });
    phoneSession.onMessage((message) => events.push({ kind: "message", message }));
    macSession.send({ t: "asset.bytes", id: 7, mime: "image/png", size: image.length });
    const sending = macSession.sendBytes(7, image).then(() => (sent = true));
    await tick();
    await tick();
    macSession.send({ t: "pong", id: 3 });
    await ended;
    await sending;
    expect(sentBeforeFirstChunk).toBe(false);
    const order = events.map((event) => {
      if (event.kind === "message") return event.message.t;
      return event.end ? "end" : "chunk";
    });
    expect(order[0]).toBe("asset.bytes");
    expect(order.indexOf("pong")).toBeGreaterThan(1);
    expect(order.indexOf("pong")).toBeLessThan(order.indexOf("end"));
    const chunks = events.flatMap((event) => (event.kind === "chunk" ? [event.chunk] : []));
    expect(Buffer.concat(chunks).equals(Buffer.from(image))).toBe(true);
  });

  it("ends the session instead of queueing more for an end that stopped reading", async () => {
    const { mac, phoneSession, macSession } = await sessions();
    const atPhone = collect<MacMessage>(phoneSession);
    const phoneClosed = closeOf(phoneSession);
    mac.buffered = 8 * 1024 * 1024;
    macSession.send({ t: "push", push: { type: "invalidate", keys: ["threads"] } });
    await tick();
    expect(atPhone).toHaveLength(1);
    mac.buffered += 1;
    macSession.send({ t: "push", push: { type: "invalidate", keys: ["threads"] } });
    expect(await phoneClosed).toBe(LinkCloseCode.timeout);
    expect(atPhone).toHaveLength(1);
    expect(macSession.closed).toBe(true);
  });

  it("tells the other end when it closes, after sending what was queued", async () => {
    const { phoneSession, macSession } = await sessions();
    const atPhone = collect<MacMessage>(phoneSession);
    const phoneClosed = closeOf(phoneSession);
    macSession.send({ t: "closing", reason: "update" });
    macSession.close(LinkCloseCode.closing, "update");
    expect(await phoneClosed).toBe(LinkCloseCode.closing);
    expect(atPhone).toEqual([{ t: "closing", reason: "update" }]);
  });
});

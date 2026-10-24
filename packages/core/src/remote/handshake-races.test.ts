import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { connectLink, decodePairingUrl, toBase64Url, type LinkSocket } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { OpenOrc } from "../openorc.js";
import type { MachineProbe } from "./routes.js";
import { LINK_PATH } from "./listener.js";
import { RemoteTestClient } from "./test-client.js";
import { linkSocket } from "./ws-socket.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (const started = Date.now(); !(await predicate()); await sleep(10)) if (Date.now() - started > 3_000) throw new Error("timed out");
}

async function withCore(machine: MachineProbe, run: (core: OpenOrc) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-remote-races-"));
  let saved: string | null = null;
  const remoteSecrets = { load: async () => saved, save: async (value: string) => void (saved = value) };
  const core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push() {} }, remoteSecrets, remoteNetwork: { port: 0, machine } });
  try {
    await core.remote.attach((request) => core.handle(request));
    await core.remote.configure(true);
    await run(core);
  } finally {
    await core.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function maskedFrame(payload: Uint8Array): Buffer {
  const mask = randomBytes(4);
  const length = payload.length < 126 ? [0x80 | payload.length] : [0x80 | 126, payload.length >> 8, payload.length & 0xff];
  return Buffer.concat([Buffer.from([0x82, ...length]), mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!))]);
}

/** Replays one captured handshake message over a fresh connection, then answers nothing, close frames included. */
function replay(port: number, message: Uint8Array) {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const upgrade = [
    `GET ${LINK_PATH} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ];
  socket.once("connect", () => socket.write(Buffer.concat([Buffer.from(upgrade.join("\r\n")), maskedFrame(message)])));
  let received = Buffer.alloc(0);
  const answered = new Promise<void>((resolve) =>
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
      const headers = received.indexOf("\r\n\r\n");
      if (headers >= 0 && received.length > headers + 4) resolve();
    }),
  );
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { answered, closed };
}

it("never counts a replayed first handshake message as a connected phone, and drops it within the deadline", async () => {
  const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };
  await withCore(machine, async (core) => {
    const offer = decodePairingUrl((await core.remote.beginPairing()).url);
    const route = offer.routes[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${route.port}${LINK_PATH}`);
    await new Promise((resolve) => ws.once("open", resolve));
    const inner = linkSocket(ws);
    let captured: Uint8Array | null = null;
    const sniffing: LinkSocket = {
      ...inner,
      send: (data) => {
        captured ??= Uint8Array.from(data);
        inner.send(data);
      },
    };
    const hello = { device: { name: "Phone" }, pair: { offerId: offer.offerId, secret: toBase64Url(offer.secret) } };
    const phone = await connectLink({ socket: sniffing, crypto: nodeCrypto, device: nodeCrypto.generateKeyPair(), macKey: offer.macKey, hello, timeoutMs: 5_000 });
    if (!phone.ok) throw new Error("the phone did not connect");
    const connected = async () => (await core.remote.status()).devices[0]?.connected === true;
    await until(connected);
    phone.session.close(1000, "");
    await until(async () => !(await connected()));

    const attacker = replay(route.port, captured!);
    await attacker.answered;
    expect(await connected()).toBe(false);
    await attacker.closed;
    expect(await connected()).toBe(false);
  });
}, 12_000);

it("gives a phone removed while it reconnects no usable session", async () => {
  const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: () => sleep(800).then(() => [] as string[]) };
  await withCore(machine, async (core) => {
    const url = (await core.remote.beginPairing()).url;
    const offer = decodePairingUrl(url);
    const first = await RemoteTestClient.pair(url);
    if (typeof first === "string") throw new Error(first);
    first.close();

    const reconnecting = RemoteTestClient.connect({ route: offer.routes[0]!, macKey: offer.macKey, device: first.device });
    await sleep(300);
    core.remote.removeDevice(first.deviceId);
    const again = await reconnecting;
    expect(again).not.toBeTypeOf("string");
    if (typeof again === "string") return;
    await again.until(() => again.closed);
    expect((await core.remote.status()).devices).toEqual([]);
  });
});

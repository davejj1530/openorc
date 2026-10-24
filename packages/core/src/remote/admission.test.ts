import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { listen } from "./listener.js";
import { PairingOffers } from "./offers.js";
import { isLocalPeer } from "./peers.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Only the listener's own clocks; sockets keep running in real time. */
const fakeClocks = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

function rawConnection(port: number): Promise<{ socket: Socket; closed: Promise<void> }> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return new Promise((resolve) => socket.once("connect", () => resolve({ socket, closed })));
}

function openSocket(port: number, options?: ClientOptions): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/link/1`, options);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("who may reach the listener", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:192.168.1.20", true],
    ["10.4.0.2", true],
    ["172.20.1.1", true],
    ["169.254.10.10", true],
    ["100.68.250.5", true],
    ["fd7a:115c:a1e0::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["8.8.8.8", false],
    ["::ffff:8.8.8.8", false],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["2001:4860:4860::8888", false],
    ["", false],
    [undefined, false],
  ])("%s is %s", (address, allowed) => {
    expect(isLocalPeer(address, [])).toBe(allowed);
  });

  it.each([
    ["2001:db8:1::b", true],
    ["2001:db8:1:0:ffff:ffff:ffff:ffff", true],
    ["2001:db8:1:1::b", false],
    ["2001:4860:4860::8888", false],
    ["::ffff:8.8.8.8", false],
    ["::808:808", false],
  ])("a global IPv6 peer %s is on the Mac's link: %s", (address, allowed) => {
    expect(isLocalPeer(address, ["::1", "192.168.1.4", "fe80::1", "2001:db8:1::a"])).toBe(allowed);
  });

  it("upgrades only GET /link/1 and answers anything else with nothing useful", async () => {
    const handshakes: string[] = [];
    const listener = await listen({
      port: 0,
      handshake: async (socket, source) => {
        handshakes.push(source);
        socket.close(1000, "done");
      },
    });
    try {
      const status = await new Promise<number>((resolve, reject) =>
        httpRequest({ host: "127.0.0.1", port: listener.port, path: "/" }, (response) => resolve(response.statusCode ?? 0))
          .on("error", reject)
          .end(),
      );
      expect(status).toBe(404);
      const wrongPath = new WebSocket(`ws://127.0.0.1:${listener.port}/link/2`);
      const opened = new Promise((resolve, reject) => {
        wrongPath.once("open", resolve);
        wrongPath.once("error", reject);
      });
      await expect(opened).rejects.toThrow();
      const right = new WebSocket(`ws://127.0.0.1:${listener.port}/link/1`, { headers: { Origin: "http://127.0.0.1:8081" } });
      await new Promise((resolve) => right.once("close", resolve));
      expect(handshakes).toEqual([expect.stringMatching(/127\.0\.0\.1$/)]);
    } finally {
      await listener.close();
    }
  });
});

describe("what the listener holds open", () => {
  it("takes at most 32 connections and drops the ones that have not upgraded within 5 s", async () => {
    fakeClocks();
    const listener = await listen({ port: 0, handshake: async (socket) => socket.close(1000, "done") });
    const connections: Array<{ socket: Socket; closed: Promise<void> }> = [];
    try {
      for (let i = 0; i < 40; i++) connections.push(await rawConnection(listener.port));
      await Promise.all(connections.slice(32).map((connection) => connection.closed));
      for (const { socket } of connections.slice(0, 16)) socket.write("GET /link/1 HTTP/1.1\r\nHost: x\r\n");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(connections.slice(0, 32).filter(({ socket }) => !socket.destroyed)).toHaveLength(32);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(connections.map((connection) => connection.closed));
      const upgraded = new WebSocket(`ws://127.0.0.1:${listener.port}/link/1`);
      expect(await new Promise<number>((resolve) => upgraded.once("close", resolve))).toBe(1000);
    } finally {
      for (const { socket } of connections) socket.destroy();
      vi.useRealTimers();
      await listener.close();
    }
  });

  it("pings every 20 s and cuts off a peer that has not answered within 10 s", async () => {
    fakeClocks();
    let heard!: () => void;
    const message = new Promise<void>((resolve) => (heard = resolve));
    const listener = await listen({ port: 0, handshake: async (socket) => socket.onMessage(() => heard()) });
    const answering = await openSocket(listener.port);
    const silent = await openSocket(listener.port, { autoPong: false });
    try {
      const silentClosed = new Promise<void>((resolve) => silent.once("close", () => resolve()));
      const pinged = Promise.all([answering, silent].map((ws) => new Promise((resolve) => ws.once("ping", resolve))));
      await vi.advanceTimersByTimeAsync(20_000);
      await pinged;
      // Its pong left before this message, so the Mac has the pong once the message arrives.
      answering.send(new Uint8Array([1]));
      await message;
      await vi.advanceTimersByTimeAsync(10_000);
      await silentClosed;
      expect(answering.readyState).toBe(WebSocket.OPEN);
    } finally {
      answering.terminate();
      silent.terminate();
      vi.useRealTimers();
      await listener.close();
    }
  });
});

describe("pairing offers", () => {
  it("work once, for five minutes, and burn after five wrong secrets", () => {
    const offers = new PairingOffers();
    const first = offers.begin(0);
    expect(offers.redeem(first.offerId, first.secret, 1)).toBe(true);
    expect(offers.redeem(first.offerId, first.secret, 2)).toBe(false);

    const expiring = offers.begin(0);
    expect(offers.redeem(expiring.offerId, expiring.secret, 5 * 60_000)).toBe(false);

    const guessed = offers.begin(0);
    for (let miss = 0; miss < 5; miss++) expect(offers.redeem(guessed.offerId, new Uint8Array(32), 1)).toBe(false);
    expect(offers.redeem(guessed.offerId, guessed.secret, 1)).toBe(false);

    const replaced = offers.begin(0);
    const newest = offers.begin(0);
    expect(offers.redeem(replaced.offerId, replaced.secret, 1)).toBe(false);
    expect(offers.cancel(newest.offerId)).toBe(true);
    expect(offers.open(1)).toBeNull();
  });
});

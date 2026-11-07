import { createServer, type Server } from "node:http";
import os from "node:os";
import type { Duplex } from "node:stream";
import { LINK_PATH, LinkCloseCode, type LinkSocket } from "@openorc/link";
import { WebSocketServer, type WebSocket } from "ws";
import { isLocalPeer } from "./peers.js";
import { linkSocket } from "./ws-socket.js";

/** Phones, handshakes and connections that have not upgraded yet, all together. */
const MAX_CONNECTIONS = 32;
const MAX_UNAUTHENTICATED = 8;
/** For a connection to upgrade, and again for the upgraded socket to finish its handshake. */
const HANDSHAKE_DEADLINE_MS = 5_000;
const PING_EVERY_MS = 20_000;
const PONG_WITHIN_MS = 10_000;
/** One sealed record: the Noise message limit. */
const MAX_MESSAGE_BYTES = 65_535;

export interface Listener {
  port: number;
  close(): Promise<void>;
}

/** Who reaches the listener: a Mac's private networks, or a TLS proxy in front of a cloud host, on `path` only. */
export type Exposure = { kind: "private" } | { kind: "proxied"; path: string };

export interface ListenOptions {
  /** Tried first; privately, a free port when it is taken, or when it is 0. */
  port: number;
  /** Private when absent. */
  exposure?: Exposure;
  /** Runs the handshake on a new socket and settles once the phone has been heard from over its session, or not admitted. */
  handshake(socket: LinkSocket, source: string): Promise<unknown>;
}

/** Handshakes per source in the last minute, so one host cannot keep the Mac busy proving keys. */
class HandshakeBudget {
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly perMinute: number) {}

  take(source: string, now: number): boolean {
    for (const [key, times] of this.recent) if (now - times.at(-1)! >= 60_000) this.recent.delete(key);
    const times = (this.recent.get(source) ?? []).filter((at) => now - at < 60_000);
    if (times.length >= this.perMinute) return false;
    times.push(now);
    this.recent.set(source, times);
    return true;
  }
}

function bindOnce(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen({ port, host, ipv6Only: false }, () => {
      server.off("error", failed);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const interfaceAddresses = () => Object.values(os.networkInterfaces()).flatMap((addresses) => (addresses ?? []).map(({ address }) => address));

/** Every interface, IPv6 and IPv4 together where the host has IPv6, IPv4 alone where it has not. */
async function bind(server: Server, port: number): Promise<number> {
  try {
    return await bindOnce(server, port, "::");
  } catch (error) {
    if (errorCode(error) !== "EAFNOSUPPORT" && errorCode(error) !== "EADDRNOTAVAIL") throw error;
    return bindOnce(server, port, "0.0.0.0");
  }
}

/** How the listener treats peers under an exposure, at each point it decides. */
interface Gate {
  /** Whether a connection from this address may stay. */
  admits(address: string | undefined): boolean;
  path: string;
  /** Ends an upgrade on another path, or by another method. */
  elsewhere(socket: Duplex): void;
  /** Whose handshake budget an upgrade from this address spends. */
  source(address: string | undefined): string;
  handshakesPerMinute: number;
  /** Whether a taken port falls back to a free one. */
  anyPort: boolean;
}

// The proxy answers a reset upstream connection with 502, as it does for a host that is asleep; this says "not here".
const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

function gate(exposure: Exposure): Gate {
  if (exposure.kind === "private")
    return {
      admits: (address) => isLocalPeer(address, interfaceAddresses()),
      path: LINK_PATH,
      elsewhere: (socket) => socket.destroy(),
      source: (address) => address ?? "",
      handshakesPerMinute: 20,
      anyPort: true,
    };
  // The proxy is the only ingress, so every peer is the proxy: nothing to filter, and one budget for all. Forwarded
  // headers are not read, as anyone may forge them. Only holders of the path's tag reach the budget at all. The proxy
  // forwards to one port, so no other will do.
  return {
    admits: () => true,
    path: exposure.path,
    elsewhere(socket) {
      socket.once("finish", () => socket.destroy());
      socket.end(NOT_FOUND);
    },
    source: () => "proxy",
    handshakesPerMinute: 60,
    anyPort: false,
  };
}

/**
 * The phone listener: one HTTP server on every interface, which upgrades only `GET` on its exposure's path. Privately
 * it drops any peer outside private networks and tailnets on connect. A browser's Origin header is not refused: the
 * handshake authenticates both ends, and React Native's WebSocket sends one.
 */
export async function listen(options: ListenOptions): Promise<Listener> {
  const peers = gate(options.exposure ?? { kind: "private" });
  const server = createServer({ headersTimeout: HANDSHAKE_DEADLINE_MS }, (_request, response) => response.writeHead(404).end());
  server.maxConnections = MAX_CONNECTIONS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const budget = new HandshakeBudget(peers.handshakesPerMinute);
  /** Every open connection, with the deadline it has to upgrade by. */
  const sockets = new Map<Duplex, ReturnType<typeof setTimeout>>();
  let unauthenticated = 0;

  server.on("connection", (socket) => {
    if (!peers.admits(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    socket.setKeepAlive(true);
    const upgradeBy = setTimeout(() => socket.destroy(), HANDSHAKE_DEADLINE_MS);
    sockets.set(socket, upgradeBy);
    socket.once("close", () => {
      clearTimeout(sockets.get(socket));
      sockets.delete(socket);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    clearTimeout(sockets.get(socket));
    if (request.method !== "GET" || request.url !== peers.path) {
      peers.elsewhere(socket);
      return;
    }
    const source = peers.source(request.socket.remoteAddress);
    if (unauthenticated >= MAX_UNAUTHENTICATED || !budget.take(source, Date.now())) {
      socket.destroy();
      return;
    }
    unauthenticated++;
    let counted = true;
    const release = () => {
      if (counted) unauthenticated--;
      counted = false;
    };
    // A failed upgrade never reaches the callback; its socket closing releases the slot.
    socket.once("close", release);
    wss.handleUpgrade(request, socket, head, (ws) => {
      heartbeat(ws);
      const link = linkSocket(ws);
      const deadline = setTimeout(() => link.close(LinkCloseCode.timeout, "handshake took too long"), HANDSHAKE_DEADLINE_MS);
      void options
        .handshake(link, source)
        .catch(() => link.close(LinkCloseCode.protocol, "handshake failed"))
        .finally(() => {
          clearTimeout(deadline);
          release();
        });
    });
  });

  let port: number;
  try {
    port = await bind(server, options.port);
  } catch (error) {
    if (errorCode(error) !== "EADDRINUSE" || options.port === 0 || !peers.anyPort) throw error;
    port = await bind(server, 0);
  }
  return {
    port,
    async close() {
      // Sessions closed just before have sent why; give their sockets a moment to deliver it.
      await drained(wss, CLOSE_GRACE_MS);
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets.keys()) socket.destroy();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const CLOSE_GRACE_MS = 500;

/** A phone whose network dropped never answers, so its session ends here instead of waiting on TCP. */
function heartbeat(ws: WebSocket): void {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const beat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.ping();
    waiting = setTimeout(() => ws.terminate(), PONG_WITHIN_MS);
  }, PING_EVERY_MS);
  ws.on("pong", () => {
    if (waiting) clearTimeout(waiting);
    waiting = null;
  });
  ws.once("close", () => {
    clearInterval(beat);
    if (waiting) clearTimeout(waiting);
  });
}

function drained(wss: WebSocketServer, timeoutMs: number): Promise<void> {
  const open = [...wss.clients].filter((client) => client.readyState !== client.CLOSED);
  if (open.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    let left = open.length;
    for (const client of open)
      client.once("close", () => {
        if (--left > 0) return;
        clearTimeout(timer);
        resolve();
      });
  });
}

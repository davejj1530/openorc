import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

export interface HubCall {
  method: string;
  path: string;
  body: unknown;
  authorized: boolean;
}

export type HubReply = { status?: number; json?: unknown; body?: Buffer | string; chunks?: Buffer[]; contentType?: string; delayMs?: number };

/** A WebSocket the fake hub accepted, from the server's side. */
export class FakeSocket {
  readonly received: (string | Buffer)[] = [];
  private buffer = Buffer.alloc(0);
  closed = false;

  constructor(
    readonly path: string,
    private readonly stream: Duplex,
  ) {
    stream.on("data", (chunk: Buffer) => this.read(chunk));
    stream.on("close", () => (this.closed = true));
    stream.on("error", () => (this.closed = true));
  }

  send(data: string | Buffer): void {
    this.stream.write(frame(typeof data === "string" ? 0x1 : 0x2, Buffer.from(data)));
  }

  close(): void {
    if (this.closed) return;
    this.stream.write(frame(0x8, Buffer.alloc(0)));
    this.stream.end();
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.length);
      if (parsed.opcode === 0x8) return this.close();
      if (parsed.opcode === 0x1) this.received.push(parsed.payload.toString("utf8"));
      if (parsed.opcode === 0x2) this.received.push(parsed.payload);
    }
  }
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

function parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const masked = (buffer[1]! & 0x80) !== 0;
  const end = offset + (masked ? 4 : 0) + length;
  if (buffer.length < end) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buffer.subarray(end - length, end));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return { opcode: buffer[0]! & 0x0f, payload, length: end };
}

/**
 * A stand-in for expo-device-hub on 127.0.0.1: every route but the health checks needs the bearer token, every call
 * is recorded, and the stream routes answer with a few chunks or a WebSocket.
 */
export class FakeHub {
  readonly calls: HubCall[] = [];
  readonly sockets: FakeSocket[] = [];
  /** Replies by "METHOD /path" (the path without its query). */
  readonly replies = new Map<string, HubReply | ((call: HubCall) => HubReply)>();
  private readonly server: http.Server;
  port = 0;

  constructor(readonly token: string) {
    this.server = http.createServer((request, response) => void this.handle(request, response));
    this.server.on("upgrade", (request: http.IncomingMessage, socket: Duplex) => this.upgrade(request, socket));
  }

  async listen(port = 0): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Sends a message to every client of `/api/devices/ws`. */
  signal(message: object): void {
    for (const socket of this.sockets) if (socket.path === "/api/devices/ws" && !socket.closed) socket.send(JSON.stringify(message));
  }

  private authorized(request: http.IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://hub");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const call: HubCall = { method: request.method ?? "GET", path: url.pathname + url.search, body: text ? (JSON.parse(text) as unknown) : null, authorized: this.authorized(request) };
    if (url.pathname === "/readyz" || url.pathname === "/healthz") return void response.writeHead(200).end("ok");
    this.calls.push(call);
    if (!call.authorized) return void response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
    const configured = this.replies.get(`${call.method} ${url.pathname}`);
    const reply = (typeof configured === "function" ? configured(call) : configured) ?? defaultReply(call.method, url.pathname);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    response.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? (reply.json === undefined ? "application/octet-stream" : "application/json") });
    if (reply.chunks) {
      for (const chunk of reply.chunks) {
        response.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return void response.end();
    }
    response.end(reply.json === undefined ? reply.body : JSON.stringify(reply.json));
  }

  private upgrade(request: http.IncomingMessage, socket: Duplex): void {
    const url = new URL(request.url ?? "/", "http://hub");
    this.calls.push({ method: "WS", path: url.pathname + url.search, body: null, authorized: this.authorized(request) });
    if (!this.authorized(request)) return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    const accept = createHash("sha1")
      .update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.sockets.push(new FakeSocket(url.pathname, socket));
  }
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

function defaultReply(method: string, pathname: string): HubReply {
  if (pathname.endsWith("/stream.avcc")) return { chunks: [Buffer.from([1, 2, 3]), Buffer.from([4, 5]), Buffer.from([6])], contentType: "video/avcc" };
  if (pathname.endsWith("/stream.mjpeg")) return { chunks: [Buffer.from("--frame\r\n")], contentType: "multipart/x-mixed-replace; boundary=frame" };
  if (pathname.endsWith("/api/screenshot")) return { body: PNG, contentType: "image/png" };
  if (pathname === "/api/devices/boot") return { json: { ok: true, serial: "emulator-5554" } };
  if (method === "POST") return { json: { ok: true } };
  return { status: 404, body: "Not Found" };
}

export async function startFakeHub(token = "hub-secret-token", port = 0): Promise<FakeHub> {
  return new FakeHub(token).listen(port);
}

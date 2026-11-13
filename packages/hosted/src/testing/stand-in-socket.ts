/**
 * The stand-in's socket: Socket.IO's own framing over a real WebSocket, enough of it for the app's client. Engine.IO's
 * open packet, the client's CONNECT with `{ token }` answered CONNECT or CONNECT_ERROR `UNAUTHORIZED`, events both
 * ways, acknowledgements of the client's events, and pings until the socket closes.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { StandInPeer } from "./stand-in-threads.js";

export interface SocketRules {
  holder(token: string | null | undefined): string | null;
  /** A peer that connected with a token the server takes. */
  joined(peer: StandInPeer): void;
  left(peer: StandInPeer): void;
  /** The server's answer to one event a client sent. */
  answer(peer: StandInPeer, event: string, body: unknown): unknown;
}

export function engineSession(request: IncomingMessage, socket: Socket, rules: SocketRules): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") return void socket.destroy();
  let peer: StandInPeer | null = null;
  const send = webSocket(key, socket, (text) => {
    if (text === "3") return;
    if (text.startsWith("40")) {
      const auth = text.length > 2 ? (JSON.parse(text.slice(2)) as { token?: string }) : {};
      if (!rules.holder(auth.token)) return send(`44${JSON.stringify({ message: "UNAUTHORIZED" })}`);
      peer = { who: () => rules.holder(auth.token), watched: new Set(), send: (event, body) => send(`42${JSON.stringify([event, body])}`) };
      rules.joined(peer);
      return send(`40${JSON.stringify({ sid: randomUUID() })}`);
    }
    const message = /^42(\d*)(\[.*)$/s.exec(text);
    if (!message || !peer) return;
    const [event, body] = JSON.parse(message[2]!) as [string, unknown];
    const reply = rules.answer(peer, event, body);
    if (message[1]) send(`43${message[1]}${JSON.stringify([reply])}`);
  });
  send(`0${JSON.stringify({ sid: randomUUID(), upgrades: [], pingInterval: 10_000, pingTimeout: 10_000, maxPayload: 1_000_000 })}`);
  const ping = setInterval(() => send("2"), 10_000);
  socket.once("close", () => {
    clearInterval(ping);
    if (peer) rules.left(peer);
  });
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The server side of RFC 6455 for short text messages: answers the upgrade, unmasks the client's frames, sends unmasked ones. */
function webSocket(key: string, socket: Socket, received: (text: string) => void): (text: string) => void {
  const accept = createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (opcode: number, payload: Buffer) => {
    const head = frameHead(opcode, payload.length);
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
  };
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0]! & 0x0f;
      let length = pending[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length).map((byte, at) => byte ^ mask[at % 4]!));
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 0x8) return void socket.end();
      if (opcode === 0x9) frame(0xa, payload);
      else if (opcode === 0x1) received(payload.toString("utf8"));
    }
  });
  socket.on("error", () => socket.destroy());
  return (text) => frame(0x1, Buffer.from(text, "utf8"));
}

/** A server frame's head: final, the opcode, and the length in the shortest of its three forms. */
function frameHead(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65_536) return Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
}

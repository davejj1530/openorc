/**
 * A stand-in for the OpenOrc server, for tests in any package (`@openorc/hosted/testing`). It serves the routes of
 * wire.ts's ROUTES over real HTTP on loopback, and the server's socket over a real WebSocket speaking Socket.IO's own
 * framing, so a test exercises the same fetch, headers, socket client and parsing the app ships.
 *
 * It keeps the real server's rules that the app's behavior depends on:
 *   a code is six digits, works once, only for the address it was sent to, for five minutes and three tries
 *   signing in answers the signed token in `set-auth-token`; the body's `token` is the bare session id, which no route takes
 *   every signed-in route answers 401 without `Authorization: Bearer <that token>`
 *   the socket takes the token in its handshake's `auth` and refuses any other with `UNAUTHORIZED`
 *   `revoke()` ends every session, so the next request answers 401, while a socket already open stays open
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { LiveSocket } from "../index.js";

export interface StandIn {
  /** Its origin, for `HostedDeps.server` or `OpenOrcOptions.accountServer`. */
  url: string;
  /** The code last emailed to an address, as the person would read it. */
  codeFor(email: string): string | undefined;
  /** What the next GET /billing answers for a person. */
  setBilling(email: string, billing: StandInBilling): void;
  /** The person's name and picture, as the server keeps them; a new person's name is made from their address. */
  setPerson(email: string, person: { name: string; image: string | null }): void;
  /** The sandbox service each person chose in Settings, by address. */
  sandboxes: Map<string, string | null>;
  /** Ends every session, so the next request is refused. */
  revoke(): void;
  /** Stops answering and drops every connection, as an unreachable server does. `up()` brings it back on the same port. */
  down(): Promise<void>;
  up(): Promise<void>;
  /** Every request it took, sockets included, to assert on. Never the token itself. */
  requests: { method: string; path: string; authorized: boolean }[];
  /** A socket held in this process under the same rules as the WebSocket one, for packages without a socket client. */
  connect(url: string, token: string): LiveSocket;
  close(): Promise<void>;
}

export type StandInBilling = { pro: false } | { pro: true; standing: "live" | "ending" | "grace"; at: string; monthlyLeftSeconds: number | null; packsLeftSeconds: number };

const NOT_INVITED = "This email doesn't belong to any organization yet.";
const CODE_MS = 5 * 60_000;
const CODE_TRIES = 3;
const MONTH_SECONDS = 40 * 3600;
const PACK_SECONDS = 20 * 3600;
const SOCKET_PATH = "/socket.io/";
/** What the real server calls each sandbox service it can run threads on. */
const SERVICE_NAMES: Record<string, string> = { local: "this machine", vercel: "Vercel", agent37: "Agent37" };

interface Peer {
  token: string;
  emit(state: "up" | "down" | "refused"): void;
  /** Whether it waits for the server to come back, as a socket client retrying does. */
  waiting: boolean;
}

type Reply = { status: number; body: unknown; token?: string };

export interface StandInOptions {
  signup?: "open" | "invite";
  invited?: string[];
  /** The sandbox services it runs threads on, its default first. The real server's default alone when unset. */
  services?: string[];
}

/** "sam.lee@acme.com" becomes "Sam Lee", as the real server names a person who signed up with a code. */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** The server's sign-in and billing rules, held in memory: codes by address, sessions by id, billing by address. */
function accounts(options: StandInOptions) {
  const secret = randomBytes(32);
  const codes = new Map<string, { code: string; at: number; tries: number }>();
  const sessions = new Map<string, string>();
  const billing = new Map<string, StandInBilling>();
  const people = new Map<string, { name: string; image: string | null }>();
  const sandboxes = new Map<string, string | null>();
  const services = options.services ?? ["local"];
  const hostedSettings = (email: string) => ({
    service: sandboxes.get(email) ?? null,
    served: services.map((service) => ({ service, name: SERVICE_NAMES[service] ?? service })),
    defaultService: services[0]!,
  });
  const sign = (id: string) => createHmac("sha256", secret).update(id).digest("base64url");
  /** The address a signed token's session is for, or null for a bare id, a forged one or an ended session. */
  const holder = (token: string | null | undefined): string | null => {
    const [id, signature] = (token ?? "").split(".");
    if (!id || !signature || signature !== sign(id)) return null;
    return sessions.get(id) ?? null;
  };
  /** Each route by method and path, given the request's body and its bearer token. */
  const routes: Record<string, (body: Record<string, unknown>, token: string | null) => Reply> = {
    "POST /api/auth/email-otp/send-verification-otp": (body) => {
      const email = String(body["email"] ?? "").toLowerCase();
      if (body["type"] !== "sign-in") return { status: 400, body: { message: "OpenOrc sends codes only to sign in." } };
      if (options.signup !== "open" && !(options.invited ?? []).includes(email)) return { status: 400, body: { code: "NOT_INVITED", message: NOT_INVITED } };
      codes.set(email, { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), at: Date.now(), tries: 0 });
      return { status: 200, body: { success: true } };
    },
    "POST /api/auth/sign-in/email-otp": (body) => {
      const email = String(body["email"] ?? "").toLowerCase();
      const sent = codes.get(email);
      if (!sent) return { status: 400, body: { code: "INVALID_OTP", message: "Invalid OTP" } };
      if (Date.now() - sent.at > CODE_MS) {
        codes.delete(email);
        return { status: 400, body: { code: "OTP_EXPIRED", message: "OTP expired" } };
      }
      if (sent.tries >= CODE_TRIES) {
        codes.delete(email);
        return { status: 403, body: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" } };
      }
      if (body["otp"] !== sent.code) {
        sent.tries++;
        return { status: 400, body: { code: "INVALID_OTP", message: "Invalid OTP" } };
      }
      codes.delete(email);
      const id = randomUUID().replaceAll("-", "");
      sessions.set(id, email);
      return { status: 200, body: { token: id, user: { id: `user-${email}`, email, name: email.split("@")[0], emailVerified: true } }, token: `${id}.${sign(id)}` };
    },
    "POST /api/auth/sign-out": (_body, token) => {
      if (holder(token)) sessions.delete(token!.split(".")[0]!);
      return { status: 200, body: { success: true } };
    },
    "GET /billing": (_body, token) => {
      const who = holder(token);
      return who ? { status: 200, body: billingState(billing.get(who) ?? { pro: false }) } : unauthorized();
    },
    // Better Auth answers null, not a 401, for a token whose session it no longer holds.
    "GET /api/auth/get-session": (_body, token) => {
      const who = holder(token);
      if (!who) return { status: 200, body: null };
      const person = people.get(who) ?? { name: nameFromEmail(who), image: null };
      return { status: 200, body: { session: { activeOrganizationId: `personal-${who}` }, user: { id: `user-${who}`, email: who, emailVerified: true, ...person } } };
    },
    "GET /settings/hosted": (_body, token) => {
      const who = holder(token);
      return who ? { status: 200, body: hostedSettings(who) } : unauthorized();
    },
    "PATCH /settings/hosted": (body, token) => {
      const who = holder(token);
      if (!who) return unauthorized();
      const service = body["service"] === null ? null : String(body["service"] ?? "");
      if (service && !services.includes(service)) return { status: 400, body: { message: `This server doesn't run threads on ${SERVICE_NAMES[service] ?? service}.`, statusCode: 400 } };
      sandboxes.set(who, service);
      return { status: 200, body: hostedSettings(who) };
    },
  };
  return { codes, sessions, billing, people, sandboxes, holder, routes };
}

export async function standIn(options: StandInOptions = {}): Promise<StandIn> {
  const { codes, sessions, billing, people, sandboxes, holder, routes } = accounts(options);
  const requests: StandIn["requests"] = [];
  const connections = new Set<Socket>();
  const peers = new Set<Peer>();
  let serving = true;
  const bearer = (request: IncomingMessage) => /^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? null;

  const server = createServer((request, response) => void answer(request, response));
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    requests.push({ method: "GET", path: SOCKET_PATH, authorized: false });
    if (!request.url?.startsWith(SOCKET_PATH)) return void socket.destroy();
    engineSession(request, socket as Socket, holder);
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request);
    const path = new URL(request.url ?? "/", "http://stand-in").pathname;
    requests.push({ method: request.method ?? "GET", path, authorized: holder(token) !== null });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const route = routes[`${request.method} ${path}`];
    const reply = route
      ? route(text ? (JSON.parse(text) as Record<string, unknown>) : {}, token)
      : { status: 404, body: { message: `Cannot ${request.method} ${path}`, error: "Not Found", statusCode: 404 } };
    response.writeHead(reply.status, { "content-type": "application/json", ...(reply.token && { "set-auth-token": reply.token, "access-control-expose-headers": "set-auth-token" }) });
    response.end(JSON.stringify(reply.body));
  }

  const admit = (peer: Peer) => {
    requests.push({ method: "GET", path: SOCKET_PATH, authorized: holder(peer.token) !== null });
    peer.waiting = false;
    queueMicrotask(() => peer.emit(holder(peer.token) ? "up" : "refused"));
  };

  await listen(server, 0);
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    codeFor: (email) => codes.get(email.toLowerCase())?.code,
    setBilling: (email, state) => void billing.set(email.toLowerCase(), state),
    setPerson: (email, person) => void people.set(email.toLowerCase(), person),
    sandboxes,
    revoke: () => sessions.clear(),
    requests,
    async down() {
      if (!serving) return;
      serving = false;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const peer of peers) {
        peer.waiting = true;
        peer.emit("down");
      }
    },
    async up() {
      if (serving) return;
      await listen(server, port);
      serving = true;
      for (const peer of peers) if (peer.waiting) admit(peer);
    },
    connect(_url, token) {
      const listeners: ((state: "up" | "down" | "refused") => void)[] = [];
      const peer: Peer = { token, waiting: true, emit: (state) => listeners.forEach((listener) => listener(state)) };
      peers.add(peer);
      if (serving) admit(peer);
      return { onState: (listener) => void listeners.push(listener), close: () => void peers.delete(peer) };
    },
    async close() {
      peers.clear();
      for (const socket of connections) socket.destroy();
      if (serving) await new Promise<void>((resolve) => server.close(() => resolve()));
      serving = false;
    },
  };
}

function unauthorized(): Reply {
  return { status: 401, body: { message: "Unauthorized", statusCode: 401 } };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** The billing state the real server answers, built from the few facts a test sets. */
function billingState(state: StandInBilling) {
  if (!state.pro) return { pro: { status: "free" }, period: null, monthly: null, packs: [], leftSeconds: 0 };
  const end = Date.parse(state.at);
  const pro =
    state.standing === "live"
      ? { status: "pro", standing: "live", renewsAt: state.at, paidBy: { kind: "self" } }
      : { status: "pro", standing: state.standing, until: state.at, paidBy: { kind: "self" } };
  const monthly = state.monthlyLeftSeconds === null ? null : { grantedSeconds: MONTH_SECONDS, usedSeconds: MONTH_SECONDS - state.monthlyLeftSeconds, leftSeconds: state.monthlyLeftSeconds };
  const packs =
    state.packsLeftSeconds > 0
      ? [
          {
            grantedSeconds: PACK_SECONDS,
            usedSeconds: PACK_SECONDS - state.packsLeftSeconds,
            leftSeconds: state.packsLeftSeconds,
            boughtAt: new Date(end - 86_400_000).toISOString(),
            expiresAt: new Date(end + 300 * 86_400_000).toISOString(),
          },
        ]
      : [];
  return {
    pro,
    period: { startsAt: new Date(end - 30 * 86_400_000).toISOString(), endsAt: state.at },
    monthly,
    packs,
    leftSeconds: (monthly?.leftSeconds ?? 0) + state.packsLeftSeconds,
  };
}

/**
 * One Socket.IO connection over a WebSocket: Engine.IO's open packet, then the client's CONNECT with `{ token }`,
 * answered CONNECT with a session id or CONNECT_ERROR `UNAUTHORIZED`, then pings until the socket closes.
 */
function engineSession(request: IncomingMessage, socket: Socket, holder: (token: string | null | undefined) => string | null): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") return void socket.destroy();
  const send = webSocket(key, socket, (text) => {
    if (text === "3") return;
    if (!text.startsWith("40")) return;
    const auth = text.length > 2 ? (JSON.parse(text.slice(2)) as { token?: string }) : {};
    send(holder(auth.token) ? `40${JSON.stringify({ sid: randomUUID() })}` : `44${JSON.stringify({ message: "UNAUTHORIZED" })}`);
  });
  send(`0${JSON.stringify({ sid: randomUUID(), upgrades: [], pingInterval: 10_000, pingTimeout: 10_000, maxPayload: 1_000_000 })}`);
  const ping = setInterval(() => send("2"), 10_000);
  socket.once("close", () => clearInterval(ping));
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The server side of RFC 6455 for short text messages: answers the upgrade, unmasks the client's frames, sends unmasked ones. */
function webSocket(key: string, socket: Socket, received: (text: string) => void): (text: string) => void {
  const accept = createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (opcode: number, payload: Buffer) => {
    const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
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

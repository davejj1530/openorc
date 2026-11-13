/**
 * The one signed-in session with the server: its token, every HTTP call, the socket, and reach. Nothing else in the
 * package builds a URL, sets a header, or learns that a request failed for the network's sake.
 *
 * State, each with this one writer:
 *   held    the token and its address, in memory and in protected storage through `deps.session`. Written by
 *           `begin` and `end` only.
 *   reach   "live" exactly while the socket's session is up. Derived from the socket, never set by an HTTP result, so
 *           two callers cannot disagree about it. A failed HTTP call only asks the socket to try again now.
 *
 * The token goes to protected storage, the socket's handshake and the Authorization header, and nowhere else: no error,
 * log line or state carries it.
 */
import { ACCOUNT_PROTOCOL_HEADER, ACCOUNT_PROTOCOL_VERSION, type AccountReach } from "@openorc/protocol";
import { z } from "zod";
import type { HostedDeps, LiveSocket } from "./index.js";
import { ROUTES, TOKEN_HEADER, wireRefusal, type Route } from "./wire.js";

/** The server cannot be reached now. Its message is the words a window shows. */
export class OutOfReach extends Error {
  constructor() {
    super("OpenOrc Cloud can't be reached.");
  }
}

/** The server answered and said no, in its own words, which it writes for people. Never carries the request. */
export class Refused extends Error {}

/** The server answered in a shape this build does not read. */
export class Unreadable extends Error {
  constructor() {
    super("OpenOrc Cloud answered in a way this version can't read. Update OpenOrc.");
  }
}

export type SessionState = { signedIn: false; ended: boolean } | { signedIn: true; email: string; reach: AccountReach };

/** `connected`: a new socket session, so pushes may have been missed and what is shown should be read again. */
export type SessionChange = "connected" | "changed";

const SIGN_IN_FIRST = "Sign in to OpenOrc first.";
const ENDED = "Your OpenOrc session ended. Sign in again.";
const REQUEST_TIMEOUT_MS = 30_000;
/** A socket drop shorter than this changes nothing on screen. */
const BLIP_MS = 2_000;
const RECONNECT_GAP_MS = 5_000;
const WORDS_MAX = 300;

const stored = z.object({ token: z.string().min(1), email: z.string().min(1) });

interface Held {
  token: string;
  email: string;
  socket: LiveSocket | null;
  reach: AccountReach;
}

export class Session {
  #held: Held | null = null;
  #ended = false;
  #closed = false;
  #blip: ReturnType<typeof setTimeout> | null = null;
  #lastConnect = Number.NEGATIVE_INFINITY;
  readonly #listeners = new Set<(change: SessionChange) => void>();
  readonly #socketListeners = new Map<string, ((body: unknown) => void)[]>();

  constructor(private readonly deps: Pick<HostedDeps, "server" | "session" | "fetch" | "connect" | "now" | "log">) {}

  get state(): SessionState {
    const held = this.#held;
    return held ? { signedIn: true, email: held.email, reach: held.reach } : { signedIn: false, ended: this.#ended };
  }

  /** Reads the stored session once. With one, connects the socket; with none, nothing reaches the server. Rejects when storage cannot be read. */
  async start(): Promise<void> {
    const parsed = stored.safeParse(parseJson(await this.deps.session.load()));
    if (parsed.success) this.#hold(parsed.data);
  }

  /**
   * A sign-in the server just took: the session is saved to protected storage, then held, then the socket connects. If
   * saving fails nothing is held and this rejects, so the app is never signed in for one launch only.
   */
  async begin(token: string, email: string): Promise<void> {
    await this.deps.session.save(JSON.stringify({ token, email }));
    this.#ended = false;
    this.#hold({ token, email });
  }

  /** Signed out, by the person or by the server. Forgets the token in memory and storage and closes the socket. Idempotent. */
  async end(why: "person" | "server"): Promise<void> {
    const held = this.#held;
    if (!held) return;
    this.#held = null;
    this.#clearBlip();
    held.socket?.close();
    this.#ended = why === "server";
    if (why === "server") this.deps.log.info("OpenOrc Cloud ended the session");
    this.#emit("changed");
    await this.deps.session.save(null).catch(() => this.deps.log.warn("could not forget the OpenOrc session in protected storage"));
  }

  /** Forgets the session here first, then tells the server, without waiting: a server out of reach still signs out here. */
  async signOut(): Promise<void> {
    const held = this.#held;
    await this.end("person");
    if (held) void this.#send(ROUTES.signOut, {}, held.token).catch(() => undefined);
  }

  /**
   * One request with the token, its reply parsed by the route's schema.
   *   no token                        -> Refused, without a request
   *   network failure, 5xx no words   -> OutOfReach, and the socket is asked to reconnect now
   *   401                             -> end("server"), then Refused
   *   other 4xx or 5xx with words     -> Refused with the server's `message`
   *   2xx that does not parse         -> Unreadable
   * Never retries by itself.
   */
  async request<T>(route: Route<T>, body?: unknown): Promise<T> {
    const held = this.#held;
    if (!held) throw new Refused(SIGN_IN_FIRST);
    const response = await this.#send(route, body, held.token);
    if (response.status === 401) {
      if (this.#held === held) await this.end("server");
      throw new Refused(ENDED);
    }
    return this.#parse(route, response);
  }

  /** A request no session needs, such as asking for a code. Refusals as in `request`, but a 401 ends nothing. */
  async anonymous(route: Route<null>, body: unknown): Promise<void> {
    await this.#parse(route, await this.#send(route, body, null));
  }

  /** The sign-in request alone answers its token, in a header. The token goes to `begin` and to nobody else. */
  async signIn(email: string, code: string): Promise<void> {
    const response = await this.#send(ROUTES.signIn, { email, otp: code }, null);
    await this.#parse(ROUTES.signIn, response);
    const token = response.headers.get(TOKEN_HEADER);
    if (!token) throw new Unreadable();
    await this.begin(token, email);
  }

  /** Heard on sign-in, sign-out, every change of reach, and every new socket session. */
  onChange(listener: (change: SessionChange) => void): void {
    this.#listeners.add(listener);
  }

  /** A message the server sends on the socket, heard on every socket this session opens. */
  onSocket(event: string, listener: (body: unknown) => void): void {
    this.#socketListeners.set(event, [...(this.#socketListeners.get(event) ?? []), listener]);
    this.#held?.socket?.on(event, listener);
  }

  /** One message on the socket with its reply, parsed. Rejects as out of reach while the socket is not up. */
  async ask<T>(event: string, body: unknown, reply: z.ZodType<T>): Promise<T> {
    const held = this.#held;
    if (!held?.socket || held.reach !== "live") throw new OutOfReach();
    const answer = await held.socket.ask(event, body).catch(() => {
      throw new OutOfReach();
    });
    const parsed = reply.safeParse(answer);
    if (!parsed.success) throw new Unreadable();
    return parsed.data;
  }

  /** The device woke or the network came back: connect now instead of at the socket's next retry. */
  awoke(): void {
    this.#reconnectSoon();
  }

  close(): void {
    this.#closed = true;
    this.#clearBlip();
    this.#held?.socket?.close();
    if (this.#held) this.#held.socket = null;
  }

  #hold(session: { token: string; email: string }): void {
    this.#held = { ...session, socket: null, reach: "offline" };
    this.#connect();
    this.#emit("changed");
  }

  #connect(): void {
    const held = this.#held;
    if (!held || this.#closed) return;
    held.socket?.close();
    this.#lastConnect = this.deps.now();
    const socket = this.deps.connect(this.deps.server, held.token);
    held.socket = socket;
    for (const [event, listeners] of this.#socketListeners) for (const listener of listeners) socket.on(event, listener);
    socket.onState((state) => {
      if (this.#held !== held || held.socket !== socket) return;
      if (state === "refused") void this.end("server");
      else if (state === "up") this.#up(held);
      else this.#down(held);
    });
  }

  #up(held: Held): void {
    this.#clearBlip();
    held.reach = "live";
    this.#emit("connected");
  }

  #down(held: Held): void {
    if (held.reach !== "live" || this.#blip) return;
    this.#blip = setTimeout(() => {
      this.#blip = null;
      if (this.#held !== held) return;
      held.reach = "offline";
      this.#emit("changed");
    }, BLIP_MS);
  }

  #reconnectSoon(): void {
    const held = this.#held;
    if (!held || held.reach === "live" || this.deps.now() - this.#lastConnect < RECONNECT_GAP_MS) return;
    this.#connect();
  }

  #clearBlip(): void {
    if (this.#blip) clearTimeout(this.#blip);
    this.#blip = null;
  }

  async #send(route: Route<unknown>, body: unknown, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { [ACCOUNT_PROTOCOL_HEADER]: String(ACCOUNT_PROTOCOL_VERSION) };
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.deps.fetch(new URL(route.path, this.deps.server), {
        method: route.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.#reconnectSoon();
      throw new OutOfReach();
    }
  }

  async #parse<T>(route: Route<T>, response: Response): Promise<T> {
    const text = await response.text().catch(() => null);
    if (response.ok) {
      if (!route.reply) return null as T;
      const parsed = route.reply.safeParse(parseJson(text));
      if (!parsed.success) throw new Unreadable();
      return parsed.data;
    }
    const refusal = wireRefusal.safeParse(parseJson(text));
    if (refusal.success) throw new Refused(refusal.data.message.slice(0, WORDS_MAX));
    // A gateway's page in front of a server that is down carries no words of the server's.
    if (response.status >= 500) {
      this.#reconnectSoon();
      throw new OutOfReach();
    }
    throw new Refused(`OpenOrc Cloud refused that (${response.status}).`);
  }

  #emit(change: SessionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

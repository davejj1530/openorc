import { fromUtf8, utf8 } from "./bytes.js";
import type { KeyPair, LinkCrypto } from "./crypto.js";
import {
  LINK_VERSION,
  LinkProtocolError,
  parseMacHello,
  parseMacMessage,
  parsePhoneHello,
  parsePhoneMessage,
  type MacHello,
  type MacMessage,
  type PhoneHello,
  type PhoneMessage,
  type Refusal,
} from "./messages.js";
import { initiate, respond } from "./noise.js";
import { LinkCloseCode, LinkSession, type LinkSocket } from "./session.js";

const PROLOGUE = utf8("openorc-link/1");
const MAX_HANDSHAKE_BYTES = 4096;

const payloadOf = (message: MacHello | PhoneHello) => utf8(JSON.stringify(message));
const parsePayload = <T>(payload: Uint8Array, parse: (value: unknown) => T): T => parse(JSON.parse(fromUtf8(payload)));

export type MacGreeting = Extract<MacHello, { t: "hello" }>;
export type PhoneSession = LinkSession<MacMessage, PhoneMessage>;
export type MacSession = LinkSession<PhoneMessage, MacMessage>;

export type ConnectResult =
  | { ok: true; session: PhoneSession; hello: MacGreeting }
  /** The Mac proved its key and declined this phone. */
  | { ok: false; refused: Refusal }
  /** Nothing usable answered: another machine at this address, a timeout or a dropped socket. Try the next route. */
  | { ok: false; refused: null; error: string };

export interface ConnectOptions {
  /** Already open. */
  socket: LinkSocket;
  crypto: LinkCrypto;
  device: KeyPair;
  /** The key pinned at pairing. */
  macKey: Uint8Array;
  hello: Omit<PhoneHello, "t" | "version">;
  timeoutMs: number;
}

/** The phone's side. Resolves once the Mac has proved the key the phone pinned, or with why not. */
export function connectLink(options: ConnectOptions): Promise<ConnectResult> {
  const { socket } = options;
  let handshake: ReturnType<typeof initiate>;
  try {
    handshake = initiate({
      crypto: options.crypto,
      prologue: PROLOGUE,
      local: options.device,
      remoteStatic: options.macKey,
      payload: payloadOf({ t: "hello", version: LINK_VERSION, ...options.hello }),
    });
  } catch (error) {
    socket.close(LinkCloseCode.protocol, "bad key");
    return Promise.resolve({ ok: false, refused: null, error: String(error) });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (code: number, error: string) => {
      socket.close(code, error);
      settle({ ok: false, refused: null, error });
    };
    const timer = setTimeout(() => fail(LinkCloseCode.timeout, "The Mac did not answer in time."), options.timeoutMs);
    socket.onClose(() => settle({ ok: false, refused: null, error: "The connection closed." }));
    socket.onMessage((data) => {
      if (settled) return;
      let finished;
      let hello;
      try {
        finished = handshake.finish(data);
        hello = parsePayload(finished.payload, parseMacHello);
      } catch {
        fail(LinkCloseCode.protocol, "The Mac at this address did not prove its key.");
        return;
      }
      if (hello.t === "refused" || hello.version !== LINK_VERSION) {
        const refused = hello.t === "refused" ? hello.reason : "incompatible";
        socket.close(LinkCloseCode.refused, refused);
        settle({ ok: false, refused });
        return;
      }
      const session: PhoneSession = new LinkSession(socket, finished.transport, parseMacMessage, options.macKey);
      // The Mac answers a replayed first handshake message too, so it counts a session only once the phone speaks.
      session.send({ t: "ping", id: 0 });
      settle({ ok: true, session, hello });
    });
    socket.send(handshake.message);
  });
}

export type Admission<A> = { ok: true; hello: Omit<MacGreeting, "t" | "version">; value: A } | { ok: false; reason: Refusal };

export interface AcceptOptions<A> {
  socket: LinkSocket;
  crypto: LinkCrypto;
  local: KeyPair;
  /** Decides on a phone that has proved it holds `remoteStatic`. */
  admit(remoteStatic: Uint8Array, hello: PhoneHello): Admission<A> | Promise<Admission<A>>;
}

type Accepted<A> = { session: MacSession; value: A };

/**
 * The Mac's side. Reads the phone's handshake, which names and proves its key, and lets `admit` decide. A refused
 * phone still gets an answer it can authenticate, saying why. Resolves null when no session came of it.
 */
export function acceptLink<A>(options: AcceptOptions<A>): Promise<Accepted<A> | null> {
  const { socket } = options;
  return new Promise((resolve) => {
    let state: "waiting" | "admitting" | "done" = "waiting";
    const settle = (result: Accepted<A> | null) => {
      state = "done";
      resolve(result);
    };
    const end = (code: number, reason: string) => {
      socket.close(code, reason);
      settle(null);
    };
    socket.onClose(() => {
      if (state !== "done") settle(null);
    });
    socket.onMessage((data) => {
      if (state === "admitting") end(LinkCloseCode.protocol, "unexpected message during the handshake");
      if (state !== "waiting") return;
      state = "admitting";
      admitPhone(options, data).then(
        (result) => {
          if ("refused" in result) end(LinkCloseCode.refused, result.refused);
          else if (state === "done" || result.session.closed) result.session.close(LinkCloseCode.normal);
          else settle(result);
        },
        () => end(LinkCloseCode.protocol, "handshake failed"),
      );
    });
  });
}

async function admitPhone<A>({ socket, crypto, local, admit }: AcceptOptions<A>, data: Uint8Array): Promise<Accepted<A> | { refused: Refusal }> {
  if (data.length > MAX_HANDSHAKE_BYTES) throw new LinkProtocolError("handshake message is too large");
  const responder = respond({ crypto, prologue: PROLOGUE, local, message: data });
  const hello = parsePayload(responder.payload, parsePhoneHello);
  const admission: Admission<A> = hello.version === LINK_VERSION ? await admit(responder.remoteStatic, hello) : { ok: false, reason: "incompatible" };
  if (!admission.ok) {
    socket.send(responder.reply(payloadOf({ t: "refused", reason: admission.reason })).message);
    return { refused: admission.reason };
  }
  const { message, transport } = responder.reply(payloadOf({ t: "hello", version: LINK_VERSION, ...admission.hello }));
  socket.send(message);
  return { session: new LinkSession(socket, transport, parsePhoneMessage, responder.remoteStatic), value: admission.value };
}

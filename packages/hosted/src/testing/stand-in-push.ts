/**
 * The stand-in's phone alerts, as the server's push routes and alerts have them:
 *   PUT /devices/:id keeps a signed-in phone under its own X25519 public key, for the session it is signed in with,
 *   replacing what it registered before; a phone that made a new key keeps only its new row. A body naming another key
 *   is refused. The answer is whether the server can send (`sender`) and the server's static public key
 *   DELETE /devices/:id takes the person's own phone off; another's, or one already gone, stays as it is
 *   `alert` alerts the person's phones as the server does at an ask or a turn's end: planned as a Mac plans its own,
 *   sealed for each phone byte for byte as packages/link push.ts seals a Mac's, with the server's key as `m`, and
 *   handed to Apple, which here only records it in `pushed`. Only a server whose sender is "ready" hands anything over
 */
import { createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";

type Reply = { status: number; body: unknown };
export type StandInSender = "ready" | "no-key" | "refused";
/** `approval` is on an ask its reader may answer from the alert: the ask's id and the run the apps know the thread's turn by. */
export type StandInNotice = { kind: "approval" | "question" | "finished" | "error"; threadId: string; title: string; body: string; approval?: { runId: string; approvalId: string } };
/** The APNs JSON the server hands Apple: fixed words outside, the notice sealed in `o`. */
export type StandInApnsPayload = {
  aps: { alert: { body: string }; "mutable-content": 1; sound?: "default"; "interruption-level"?: "passive" };
  o: { v: number; m: string; n: string; c: string };
};
interface Device {
  who: string;
  session: string;
  token: string;
  environment: "sandbox" | "production";
  alerts: "all" | "needs-you";
  sound: boolean;
}

export const KEY_IS_ID = "A phone registers under its own key.";
/** All Apple, and a phone that cannot open the alert, ever show. */
export const OUTER_TEXT = "New activity in OpenOrc Cloud";
const LABEL = "openorc push v1";
const KEY = /^[A-Za-z0-9_-]{43}$/;
const BAD_KEY = "The key must be the base64url of 32 bytes.";
const INVALID = "Invalid input";
const QUIET_WINDOW_MS = 60_000;
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const TITLE_MAX = 120;
const BODY_MAX = 600;
const PAYLOAD_MAX_BYTES = 4096;

const refused = (status: number, message: string): Reply => ({ status, body: { message, statusCode: status } });
const x25519Public = (raw: Uint8Array) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

export class StandInPush {
  /** What the next registration answers, and whether `alert` hands anything to Apple: only when "ready". */
  sender: StandInSender = "no-key";
  /** Every alert handed to Apple, in order, for the phone with `token`. */
  readonly pushed: { token: string; payload: StandInApnsPayload }[] = [];
  /** The server's static public key, base64url: every alert names it as `m`. */
  readonly publicKey: string;
  readonly #privateKey: KeyObject;
  readonly #devices = new Map<string, Device>();
  /** What last rang a phone about a thread, and when, for the quiet window. */
  readonly #rang = new Map<string, { group: "needs-you" | "outcome"; at: number }>();

  constructor(
    private readonly server: {
      /** The person and session a bearer token names; null for none, a forged one or an ended session. */
      caller(token: string | null): { who: string; session: string } | null;
      /** Whether the session a phone registered with is still signed in. */
      live(session: string): boolean;
      /** Whether someone is at one of the person's computers, as the server asks before an alert. */
      presence(who: string): Promise<boolean>;
    },
  ) {
    const pair = generateKeyPairSync("x25519");
    this.#privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("base64url");
  }

  /** The phones the person registered, with sessions still signed in. */
  devices(email: string): (Registration & { id: string })[] {
    return this.#of(email.toLowerCase()).map(({ id, device }) => ({ id, token: device.token, environment: device.environment, alerts: device.alerts, sound: device.sound }));
  }

  /** The routes under /devices, for the person and session the bearer `token` names; null for any other path. */
  route(method: string, path: string, body: Record<string, unknown>, token: string | null): Reply | null {
    const id = /^\/devices\/([^/]+)$/.exec(path)?.[1];
    if (id === undefined || (method !== "PUT" && method !== "DELETE")) return null;
    const caller = this.server.caller(token);
    if (!caller) return refused(401, "Unauthorized");
    if (!KEY.test(id)) return refused(400, BAD_KEY);
    if (method === "PUT") return this.#register(id, body, caller);
    // Only the person's own phone goes; another's, or one already gone, stays as it is.
    if (this.#devices.get(id)?.who === caller.who) this.#devices.delete(id);
    return { status: 200, body: {} };
  }

  #register(id: string, body: Record<string, unknown>, caller: { who: string; session: string }): Reply {
    const registration = registrationOf(body);
    if (typeof registration === "string") return refused(400, registration);
    if (body["publicKey"] !== id) return refused(400, KEY_IS_ID);
    // A token is one phone's at Apple: a row another id kept for it goes.
    for (const [other, device] of this.#devices) if (other !== id && device.token === registration.token && device.environment === registration.environment) this.#devices.delete(other);
    this.#devices.set(id, { ...caller, ...registration });
    return { status: 200, body: { sender: this.sender, publicKey: this.publicKey } };
  }

  /** Alerts the person's phones of `notice`, as the server does at an ask or a turn's end. Resolves once each was handed over or passed by. */
  async alert(email: string, notice: StandInNotice): Promise<void> {
    const who = email.toLowerCase();
    const phones = this.#of(who);
    if (this.sender !== "ready" || phones.length === 0) return;
    const inUse = await this.server.presence(who);
    const group = notice.kind === "approval" || notice.kind === "question" ? "needs-you" : "outcome";
    const sealed = { id: randomUUID(), ...notice };
    for (const { id, device } of phones) {
      const plan = this.#plan(group, device, inUse, this.#rang.get(`${id}:${notice.threadId}`));
      if (!plan) continue;
      const payload = fitPayload(sealed, plan, (fitted) => this.#seal(id, fitted));
      if (!payload) continue;
      this.pushed.push({ token: device.token, payload });
      if (plan.kind === "ring") this.#rang.set(`${id}:${notice.threadId}`, { group, at: Date.now() });
    }
  }

  #of(who: string): { id: string; device: Device }[] {
    return [...this.#devices].filter(([, device]) => device.who === who && this.server.live(device.session)).map(([id, device]) => ({ id, device }));
  }

  /** As a Mac plans its own: an outcome a phone does not take, or one already on the person's screen, is not sent; an ask then, or after a ring, comes quietly. */
  #plan(group: "needs-you" | "outcome", device: Device, inUse: boolean, rang: { group: string; at: number } | undefined): Plan | null {
    if (device.alerts === "needs-you" && group === "outcome") return null;
    if (inUse) return group === "outcome" ? null : { kind: "quiet" };
    const lastRing = rang && Date.now() - rang.at < QUIET_WINDOW_MS ? rang.group : null;
    if (lastRing && (group !== "needs-you" || lastRing === "needs-you")) return { kind: "quiet" };
    return { kind: "ring", sound: device.sound };
  }

  /** Sealed as the server seals: X25519 of the two static keys, HKDF-SHA256 for `seal`, AES-256-GCM with the sender in the associated data. */
  #seal(phoneId: string, notice: object): StandInApnsPayload["o"] {
    const phone = Buffer.from(phoneId, "base64url");
    const server = Buffer.from(this.publicKey, "base64url");
    const secret = diffieHellman({ privateKey: this.#privateKey, publicKey: x25519Public(phone) });
    const seal = hmac(hmac(Buffer.from(LABEL), secret), Buffer.concat([Buffer.from("seal"), server, phone, Uint8Array.of(1)]));
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(notice, (_key, value: unknown) => (typeof value === "string" ? wellFormed(value) : value)));
    const cipher = createCipheriv("aes-256-gcm", seal, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${LABEL}.${this.publicKey}`), { plaintextLength: plaintext.length });
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { v: 1, m: this.publicKey, n: nonce.toString("base64url"), c: sealed.toString("base64url") };
  }
}

type Plan = { kind: "ring"; sound: boolean } | { kind: "quiet" };
type Registration = Pick<Device, "token" | "environment" | "alerts" | "sound">;

/** The registration a body gives, or the words refusing it. */
function registrationOf({ token, environment, alerts, sound, publicKey }: Record<string, unknown>): Registration | string {
  if (typeof token !== "string" || !/^[0-9a-f]{64,200}$/.test(token)) return "The token must be lowercase hex.";
  if (typeof publicKey !== "string" || !KEY.test(publicKey)) return BAD_KEY;
  if (environment !== "sandbox" && environment !== "production") return INVALID;
  if (alerts !== "all" && alerts !== "needs-you") return INVALID;
  return typeof sound === "boolean" ? { token, environment, alerts, sound } : INVALID;
}

/** At most `max` code points, the last of them "…" when anything was cut. */
function clip(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max < 1 ? "" : `${points.slice(0, max - 1).join("")}…`;
}

/** Half an emoji, which a cut through one leaves, becomes U+FFFD: the phone's decoder refuses the escape JSON writes for it. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
const wellFormed = (text: string) => text.replace(SURROGATES, (found) => (found.length === 2 ? found : "\uFFFD"));

/** The APNs JSON for a notice, its body halved until the whole fits Apple's limit; null when even no body is too much. */
function fitPayload(notice: StandInNotice & { id: string }, plan: Plan, seal: (notice: object) => StandInApnsPayload["o"]): StandInApnsPayload | null {
  const aps: StandInApnsPayload["aps"] = {
    alert: { body: OUTER_TEXT },
    "mutable-content": 1,
    ...(plan.kind === "ring" && plan.sound ? { sound: "default" as const } : {}),
    ...(plan.kind === "quiet" ? { "interruption-level": "passive" as const } : {}),
  };
  let fitted = { ...notice, title: clip(notice.title, TITLE_MAX), body: clip(notice.body, BODY_MAX) };
  for (;;) {
    const payload = { aps, o: seal(fitted) };
    if (Buffer.byteLength(JSON.stringify(payload)) <= PAYLOAD_MAX_BYTES) return payload;
    const length = Array.from(fitted.body).length;
    if (length === 0) return null;
    fitted = { ...fitted, body: clip(fitted.body, Math.floor(length / 2)) };
  }
}

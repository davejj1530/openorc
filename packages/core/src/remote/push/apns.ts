import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2, { type ClientHttp2Session } from "node:http2";
import type { PushEnvironment } from "@openorc/protocol";
import type { PushDelivery, PushOutcome, PushRoute } from "./route.js";

export interface ApnsKey {
  keyId: string;
  teamId: string;
  pem: string;
}

export const APNS_ORIGINS: Record<PushEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** Apple asks for a new provider token at least hourly and at most every 20 minutes. */
const TOKEN_REUSE_MS = 50 * 60_000;
const TOKEN_REFRESH_FLOOR_MS = 20 * 60_000;
/** A connection unused this long may have died while the Mac slept, so it is replaced before use. */
const IDLE_MS = 5 * 60_000;
const ANSWER_WITHIN_MS = 10_000;
const SILENT = "APNs did not answer in time.";
/**
 * Once a fresh connection is silent too, the Mac cannot reach Apple (a captive portal, a dead network). Alerts to that
 * environment then fail at once for this long, rather than each holding every later one up for two answer waits.
 */
const SILENT_PAUSE_MS = 30_000;

const outcomes: Record<string, "gone" | "refused"> = {
  BadDeviceToken: "gone",
  DeviceTokenNotForTopic: "gone",
  Unregistered: "gone",
  ExpiredToken: "gone",
  InvalidProviderToken: "refused",
  MissingProviderToken: "refused",
  ExpiredProviderToken: "refused",
  BadEnvironmentKeyIdInToken: "refused",
  UnrelatedKeyIdInToken: "refused",
  Forbidden: "refused",
  TopicDisallowed: "refused",
  BadTopic: "refused",
};

/** The `.p8` Apple hands out: an EC P-256 private key. The error never repeats the text it was given. */
export function apnsSigningKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return key;
  } catch {
    // Unreadable text is refused below, without its contents.
  }
  throw new Error("This is not an Apple push key.");
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** APNs token auth: an ES256 JWT, whose signature is the raw 64-byte r‖s, not Node's default DER. */
export function providerToken(signingKey: KeyObject, keyId: string, teamId: string, at: number): string {
  const unsigned = `${base64url({ alg: "ES256", kid: keyId })}.${base64url({ iss: teamId, iat: Math.floor(at / 1000) })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: signingKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/**
 * What came back for one request. A lost one may be sent again only when Apple cannot have taken it: no GOAWAY named
 * its stream among the ones Apple still answers.
 */
type Answer = { kind: "answer"; status: number; reason: string | null } | { kind: "lost"; reason: string; resend: boolean };

function outcomeOf(answer: Answer): PushOutcome {
  if (answer.kind === "lost") return { kind: "failed", reason: answer.reason };
  if (answer.status === 200) return { kind: "sent" };
  const reason = answer.reason ?? `HTTP ${answer.status}`;
  // Every 403 is about the key or its token, so one whose reason never arrived is a refusal all the same.
  return { kind: outcomes[reason] ?? (answer.status === 403 ? "refused" : "failed"), reason };
}

function reasonOf(body: string): string | null {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

interface Connection {
  session: ClientHttp2Session;
  usedAt: number;
}

const CLOSED = "The connection to APNs closed.";
const TAKEN = "The connection to APNs closed before it answered.";

/**
 * Straight to Apple from this Mac: one HTTP/2 connection per environment, one request at a time. A lost connection
 * is retried once on a fresh one; nothing is queued past that, and an environment silent twice rests a while. Tests
 * pass the origins of a fake h2c server and a clock.
 */
export class ApnsRoute implements PushRoute {
  private readonly answerWithinMs: number;
  /** The parsed key only signs tokens; the PEM itself is not kept. */
  private readonly signingKey: KeyObject;
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly topic: string;
  private readonly origins: Record<PushEnvironment, string>;
  private readonly now: () => number;
  /** The connection each environment sends on next. */
  private readonly connections = new Map<PushEnvironment, Connection>();
  /** Every connection still open, including ones Apple sent away that are finishing what it still answers. */
  private readonly sessions = new Set<ClientHttp2Session>();
  private token: { jwt: string; at: number } | null = null;
  /** When each environment that stayed silent may be tried again. */
  private readonly silentUntil = new Map<PushEnvironment, number>();
  private turn: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: { key: ApnsKey; topic: string; origins?: Record<PushEnvironment, string>; now?: () => number; answerWithinMs?: number }) {
    this.signingKey = apnsSigningKey(options.key.pem);
    this.keyId = options.key.keyId;
    this.teamId = options.key.teamId;
    this.topic = options.topic;
    this.origins = options.origins ?? APNS_ORIGINS;
    this.now = options.now ?? Date.now;
    this.answerWithinMs = options.answerWithinMs ?? ANSWER_WITHIN_MS;
  }

  send(delivery: PushDelivery): Promise<PushOutcome> {
    const outcome = this.turn.then(() => this.deliver(delivery)).catch((error: unknown): PushOutcome => ({ kind: "failed", reason: error instanceof Error ? error.message : String(error) }));
    this.turn = outcome;
    return outcome;
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions) session.destroy();
    this.connections.clear();
  }

  private async deliver(delivery: PushDelivery): Promise<PushOutcome> {
    if (this.closed) return { kind: "failed", reason: "This route is closed." };
    if (this.now() < (this.silentUntil.get(delivery.environment) ?? 0)) return { kind: "failed", reason: SILENT };
    const answer = await this.postOnce(delivery);
    // Apple calls a token expired an hour after it was signed; a younger one means this Mac's clock is off.
    if (answer.kind === "answer" && answer.reason === "ExpiredProviderToken" && this.token && this.now() - this.token.at >= TOKEN_REFRESH_FLOOR_MS) {
      this.token = null;
      return outcomeOf(await this.postOnce(delivery));
    }
    return outcomeOf(answer);
  }

  /** One request, sent again on a fresh connection if the first one was lost before Apple could take it. */
  private async postOnce(delivery: PushDelivery): Promise<Answer> {
    const answer = await this.post(delivery);
    if (answer.kind !== "lost" || !answer.resend || this.closed) return answer;
    const again = await this.post(delivery);
    if (again.kind === "lost" && again.reason === SILENT) this.silentUntil.set(delivery.environment, this.now() + SILENT_PAUSE_MS);
    return again;
  }

  private post(delivery: PushDelivery): Promise<Answer> {
    const { environment } = delivery;
    const session = this.session(environment);
    return new Promise((resolve) => {
      let status = 0;
      let body = "";
      let settled = false;
      let request: http2.ClientHttp2Stream | undefined;
      /** The last stream Apple still answers, once a GOAWAY sent this connection away. A later GOAWAY can only lower it. */
      let lastStream: number | null = null;
      const away = (_code: number, last: number) => (lastStream = Math.min(last, lastStream ?? last));
      const settle = (answer: Answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("goaway", away);
        if (answer.kind === "lost") this.drop(environment, session);
        resolve(answer);
      };
      // However the stream ends, Apple has answered once its status is here, even if the body that names why never came.
      // Without one, a stream Apple named as one it still answers may have been delivered: sent again, it could ring twice.
      const finish = (reason: string) => {
        if (status) return settle({ kind: "answer", status, reason: reasonOf(body) });
        const stream = request?.id;
        const taken = lastStream !== null && stream !== undefined && stream <= lastStream;
        settle(taken ? { kind: "lost", reason: TAKEN, resend: false } : { kind: "lost", reason, resend: true });
      };
      const timer = setTimeout(() => finish(SILENT), this.answerWithinMs);
      session.on("goaway", away);
      try {
        request = session.request(this.headers(delivery));
        request.setEncoding("utf8");
        request.on("response", (headers) => (status = Number(headers[":status"])));
        request.on("data", (chunk: string) => (body += chunk));
        request.on("error", (error) => finish(error.message));
        request.on("close", () => finish(CLOSED));
        request.end(delivery.payload);
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private headers(delivery: PushDelivery): http2.OutgoingHttpHeaders {
    return {
      ":method": "POST",
      ":path": `/3/device/${delivery.token}`,
      authorization: `bearer ${this.jwt()}`,
      "apns-topic": this.topic,
      "apns-push-type": "alert",
      "apns-priority": String(delivery.priority),
      "apns-expiration": String(delivery.expiresAt),
      "apns-collapse-id": delivery.collapseId,
      [http2.sensitiveHeaders]: [":path", "authorization"],
    };
  }

  private jwt(): string {
    const now = this.now();
    if (!this.token || now - this.token.at >= TOKEN_REUSE_MS) {
      this.token = { jwt: providerToken(this.signingKey, this.keyId, this.teamId, now), at: now };
    }
    return this.token.jwt;
  }

  private session(environment: PushEnvironment): ClientHttp2Session {
    const now = this.now();
    const current = this.connections.get(environment);
    if (current && !current.session.closed && !current.session.destroyed && now - current.usedAt <= IDLE_MS) {
      current.usedAt = now;
      return current.session;
    }
    if (current) this.drop(environment, current.session);
    const session = http2.connect(this.origins[environment]);
    this.sessions.add(session);
    // Errors reach the request in flight; the session only has to be forgotten.
    session.on("error", () => this.drop(environment, session));
    // Sent away, a connection takes no new request but finishes the ones Apple still answers, as HTTP/2 intends.
    session.on("goaway", () => this.forget(environment, session));
    session.on("close", () => this.drop(environment, session));
    this.connections.set(environment, { session, usedAt: now });
    return session;
  }

  private forget(environment: PushEnvironment, session: ClientHttp2Session): void {
    if (this.connections.get(environment)?.session === session) this.connections.delete(environment);
  }

  private drop(environment: PushEnvironment, session: ClientHttp2Session): void {
    this.forget(environment, session);
    this.sessions.delete(session);
    if (!session.destroyed) session.destroy();
  }
}

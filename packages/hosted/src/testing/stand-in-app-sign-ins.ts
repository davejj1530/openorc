/**
 * The stand-in's sign-in through the browser, as the contract in the server's app-sign-in routes has it:
 *   start takes a loopback port, the challenge of the app's verifier and a device name, and answers the web page for
 *   the request, which lasts ten minutes
 *   the page signs the person in with the code mailed to them and approves the request, answering the app's loopback
 *   with the request and a one-time code (`signInPage` plays the page)
 *   finish takes the request, the code and the verifier whose SHA-256 is the challenge, once, and answers the session's
 *   token; anything else is one 410 with the same words. A wrong code leaves the request alone; the right code uses it up
 *   whatever the verifier
 *   grant, from a signed-in device, makes a request already approved for that person, for the challenge of a verifier
 *   another of their devices holds, and answers its code at once; it lasts two minutes, ten a person per ten minutes
 */
import { createHash, randomBytes } from "node:crypto";

type Reply = { status: number; body: unknown };

const REQUEST_MS = 10 * 60_000;
/** A granted sign-in is passed straight to the other device, so it lasts much less. */
const GRANT_MS = 2 * 60_000;
const GRANTS = { windowMs: 10 * 60_000, max: 10 };
const TOO_MANY = "That's a lot of tries from here. Wait a few minutes and try again.";
/** The server's one refusal of a finish, whatever the reason. */
const CANT_FINISH = "This sign-in can't be finished. Sign in again.";

interface Request {
  /** The loopback port the page sends the browser back to; null for a granted sign-in, which no browser returns from. */
  port: number | null;
  challenge: string;
  device: string;
  at: number;
  lastsMs: number;
  approved: { who: string; code: string } | null;
}

const refused = (status: number, message: string): Reply => ({ status, body: { message, statusCode: status } });

export class StandInAppSignIns {
  readonly #requests = new Map<string, Request>();
  /** When each person last granted a sign-in, for the limit. */
  readonly #grants = new Map<string, number[]>();
  /** Every device name a start was given, in order. */
  readonly devices: string[] = [];

  constructor(
    private readonly server: {
      /** The web page's origin, which `start` builds its address from. */
      web(): string;
      /** Makes a session for the person and answers its signed token. */
      session(who: string): string;
      /** Checks a code mailed to the person, as signing in with it does: null when it is right, else the refusal. */
      checkCode(who: string, otp: string): Reply | null;
      /** Mails the person a code, answering it as they read it, or the refusal. */
      mail(who: string): Reply & { code?: string };
    },
  ) {}

  /** The routes under /app-sign-in the app and the page call, `who` being the bearer's person if any; null for any other. */
  route(method: string, path: string, body: Record<string, unknown>, who: string | null): Reply | null {
    const routes: Record<string, () => Reply> = {
      "POST /app-sign-in/start": () => this.#start(body),
      "POST /app-sign-in/grant": () => (who ? this.#grant(who, body) : refused(401, "Unauthorized")),
      "POST /app-sign-in/approve": () => this.#approve(String(body["request"] ?? ""), String(body["email"] ?? "").toLowerCase(), String(body["otp"] ?? "")),
      "POST /app-sign-in/finish": () => this.#finish(String(body["request"] ?? ""), String(body["code"] ?? ""), String(body["verifier"] ?? "")),
      "POST /app-sign-in/cancel": () => this.#cancel(String(body["request"] ?? ""), String(body["verifier"] ?? "")),
    };
    return routes[`${method} ${path}`]?.() ?? null;
  }

  /** The person signs in on the page for `url`: a code is mailed, typed in, and the request approved. Answers the return, or throws the page's words. */
  signInPage(url: string, who: string): string {
    const mailed = this.server.mail(who);
    const approved = mailed.status === 200 ? this.#approve(new URL(url).searchParams.get("request") ?? "", who, mailed.code ?? "") : mailed;
    if (approved.status !== 200) throw new Error((approved.body as { message: string }).message);
    return (approved.body as { returnTo: string }).returnTo;
  }

  /** Every request runs out, as ten minutes passing would. */
  expire(): void {
    for (const request of this.#requests.values()) request.at -= REQUEST_MS;
  }

  #start(body: Record<string, unknown>): Reply {
    const { port, challenge, device } = body;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65_535) return refused(400, "port must be a loopback port.");
    const wrong = badChallenge(challenge, device);
    if (wrong) return wrong;
    const id = randomBytes(24).toString("base64url");
    this.#requests.set(id, { port, challenge: String(challenge), device: String(device), at: Date.now(), lastsMs: REQUEST_MS, approved: null });
    this.devices.push(String(device));
    return { status: 200, body: { request: id, url: `${this.server.web()}/sign-in?request=${id}`, resultUrl: `${this.server.web()}/sign-in/complete`, expiresInMs: REQUEST_MS } };
  }

  #grant(who: string, body: Record<string, unknown>): Reply {
    const { challenge, device } = body;
    const wrong = badChallenge(challenge, device);
    if (wrong) return wrong;
    const recent = (this.#grants.get(who) ?? []).filter((at) => Date.now() - at < GRANTS.windowMs);
    if (recent.length >= GRANTS.max) return refused(429, TOO_MANY);
    this.#grants.set(who, [...recent, Date.now()]);
    const id = randomBytes(24).toString("base64url");
    const code = randomBytes(24).toString("base64url");
    this.#requests.set(id, { port: null, challenge: String(challenge), device: String(device), at: Date.now(), lastsMs: GRANT_MS, approved: { who, code } });
    return { status: 200, body: { request: id, code, expiresInMs: GRANT_MS } };
  }

  #approve(id: string, who: string, otp: string): Reply {
    const request = this.#live(id);
    // A granted sign-in is approved already, and no browser goes back to it.
    if (request?.port == null) return refused(410, CANT_FINISH);
    const wrong = this.server.checkCode(who, otp);
    if (wrong) return wrong;
    const code = randomBytes(24).toString("base64url");
    request.approved = { who, code };
    return { status: 200, body: { returnTo: `http://127.0.0.1:${request.port}/signed-in?request=${id}&code=${code}` } };
  }

  #finish(id: string, code: string, verifier: string): Reply {
    const request = this.#live(id);
    if (!request?.approved || request.approved.code !== code) return refused(410, CANT_FINISH);
    this.#requests.delete(id);
    if (createHash("sha256").update(verifier).digest("base64url") !== request.challenge) return refused(410, CANT_FINISH);
    return { status: 200, body: { token: this.server.session(request.approved.who) } };
  }

  #cancel(id: string, verifier: string): Reply {
    const request = this.#live(id);
    if (!request) return { status: 200, body: {} };
    if (createHash("sha256").update(verifier).digest("base64url") !== request.challenge) return refused(410, CANT_FINISH);
    this.#requests.delete(id);
    return { status: 200, body: {} };
  }

  #live(id: string): Request | null {
    const request = this.#requests.get(id);
    return request && Date.now() - request.at < request.lastsMs ? request : null;
  }
}

/** A challenge and a device name as a start or a grant takes them, or the refusal. */
function badChallenge(challenge: unknown, device: unknown): Reply | null {
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return refused(400, "challenge must be a SHA-256 in base64url.");
  if (typeof device !== "string" || !device || device.length > 80) return refused(400, "device must be a short name.");
  return null;
}

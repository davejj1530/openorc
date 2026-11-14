/**
 * The stand-in's sign-in through the browser, as the contract in the server's app-sign-in routes has it:
 *   start takes a loopback port, the challenge of the app's verifier and a device name, and answers the web page for
 *   the request, which lasts ten minutes
 *   the page signs the person in with the code mailed to them and approves the request, answering the app's loopback
 *   with the request and a one-time code (`signInPage` plays the page)
 *   finish takes the request, the code and the verifier whose SHA-256 is the challenge, once, and answers the session's
 *   token; anything else is one 410 with the same words. A wrong code leaves the request alone; the right code uses it up
 *   whatever the verifier
 */
import { createHash, randomBytes } from "node:crypto";

type Reply = { status: number; body: unknown };

const REQUEST_MS = 10 * 60_000;
/** The server's one refusal of a finish, whatever the reason. */
const CANT_FINISH = "This sign-in can't be finished. Sign in again.";

interface Request {
  port: number;
  challenge: string;
  device: string;
  at: number;
  approved: { who: string; code: string } | null;
}

const refused = (status: number, message: string): Reply => ({ status, body: { message, statusCode: status } });

export class StandInAppSignIns {
  readonly #requests = new Map<string, Request>();
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

  /** The routes under /app-sign-in the app and the page call; null for any other. */
  route(method: string, path: string, body: Record<string, unknown>): Reply | null {
    const routes: Record<string, () => Reply> = {
      "POST /app-sign-in/start": () => this.#start(body),
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
    if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return refused(400, "challenge must be a SHA-256 in base64url.");
    if (typeof device !== "string" || !device || device.length > 80) return refused(400, "device must be a short name.");
    const id = randomBytes(24).toString("base64url");
    this.#requests.set(id, { port, challenge, device, at: Date.now(), approved: null });
    this.devices.push(device);
    return { status: 200, body: { request: id, url: `${this.server.web()}/sign-in?request=${id}`, resultUrl: `${this.server.web()}/sign-in/complete`, expiresInMs: REQUEST_MS } };
  }

  #approve(id: string, who: string, otp: string): Reply {
    const request = this.#live(id);
    if (!request) return refused(410, CANT_FINISH);
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
    return request && Date.now() - request.at < REQUEST_MS ? request : null;
  }
}

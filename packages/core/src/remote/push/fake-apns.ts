import { randomUUID, verify, type KeyObject } from "node:crypto";
import http2, { type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";

type FakeStatus = { status: 200 } | { status: number; reason: string };
/**
 * How the fake answers one request: a status (with Apple's reason when it is not 200), or a way to fail.
 * - A status can come with a GOAWAY that still answers this request, sent before the answer (which follows 50 ms later)
 *   or after it. "error" sends one with an error code right after the answer. HTTP/2 puts the GOAWAY on the wire
 *   ahead of the queued body, so the client hears the status and then loses the connection, before the body.
 * - "goaway" sends a GOAWAY that answers only the requests before this one, so this one was never taken. Node reads a
 *   last stream of 0 as the last one it processed, so the connection must have carried a request before.
 * - "taken" sends a GOAWAY with an error code that names this request as one Apple may have taken, and never answers.
 * - "drop" resets the TCP connection with no GOAWAY, as a network that went away does.
 */
export type FakeReply = FakeStatus | (FakeStatus & { goaway: "before" | "after" | "error" }) | "goaway" | "taken" | "drop" | "silence";

export interface FakeApnsRequest {
  /** Which connection carried it, counted from 1. */
  session: number;
  token: string;
  headers: IncomingHttpHeaders;
  jwt: { header: Record<string, unknown>; claims: Record<string, unknown>; raw: string };
  body: string;
  /** Everything about the request Apple would refuse or this design forbids. Empty for a good one. */
  problems: string[];
}

export interface FakeApnsExpectations {
  publicKey: KeyObject;
  keyId: string;
  teamId: string;
  topic: string;
}

const decodeJson = (part: string | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** APNs for tests: cleartext HTTP/2 on 127.0.0.1, checking each request the way Apple would and answering from a script. */
export class FakeApns {
  readonly requests: FakeApnsRequest[] = [];
  /** The most requests it ever had open at once. */
  maxInFlight = 0;
  private inFlight = 0;
  private sessionCount = 0;
  private readonly replies: FakeReply[] = [];
  private readonly sessions = new Set<ServerHttp2Session>();
  private readonly server = http2.createServer();

  private constructor(private readonly expected: FakeApnsExpectations) {
    this.server.on("session", (session) => {
      const id = ++this.sessionCount;
      this.sessions.add(session);
      session.on("close", () => this.sessions.delete(session));
      session.on("error", () => undefined);
      session.on("stream", (stream, headers) => this.receive(id, stream, headers));
    });
  }

  static async start(expected: FakeApnsExpectations): Promise<FakeApns> {
    const fake = new FakeApns(expected);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get problems(): string[] {
    return this.requests.flatMap((request) => request.problems);
  }

  get openSessions(): number {
    return [...this.sessions].filter((session) => !session.closed && !session.destroyed).length;
  }

  /** Queued in order; once they run out, every request gets 200. */
  reply(...replies: FakeReply[]): void {
    this.replies.push(...replies);
  }

  async close(): Promise<void> {
    for (const session of this.sessions) session.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private receive(session: number, stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    stream.on("close", () => (this.inFlight -= 1));
    stream.on("error", () => undefined);
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => {
      const path = String(headers[":path"] ?? "");
      const raw = String(headers["authorization"] ?? "").replace(/^bearer /, "");
      const [header, claims] = raw.split(".");
      const request: FakeApnsRequest = { session, token: path.replace("/3/device/", ""), headers, jwt: { header: decodeJson(header), claims: decodeJson(claims), raw }, body, problems: [] };
      request.problems = this.check(request);
      this.requests.push(request);
      this.answer(stream, this.replies.shift() ?? { status: 200 });
    });
  }

  private answer(stream: ServerHttp2Stream, reply: FakeReply): void {
    if (reply === "silence" || stream.destroyed) return;
    if (reply === "drop") return void stream.session?.socket.resetAndDestroy();
    if (reply === "goaway") return void stream.session?.goaway(http2.constants.NGHTTP2_NO_ERROR, (stream.id ?? 0) - 2);
    // The client ends a session sent away with an error at once; the fake's side follows once the GOAWAY is out.
    if (reply === "taken") {
      stream.session?.goaway(http2.constants.NGHTTP2_INTERNAL_ERROR, stream.id);
      return void setTimeout(() => stream.session?.destroy(), 50);
    }
    const code = "goaway" in reply && reply.goaway === "error" ? http2.constants.NGHTTP2_INTERNAL_ERROR : http2.constants.NGHTTP2_NO_ERROR;
    const goaway = () => stream.session?.goaway(code, stream.id);
    if ("goaway" in reply && reply.goaway === "before") {
      goaway();
      return void setTimeout(() => this.respond(stream, reply), 50);
    }
    this.respond(stream, reply);
    if ("goaway" in reply) goaway();
  }

  private respond(stream: ServerHttp2Stream, reply: FakeStatus): void {
    if (stream.destroyed) return;
    stream.respond({ ":status": reply.status, "apns-id": randomUUID() });
    stream.end("reason" in reply ? JSON.stringify({ reason: reply.reason, ...(reply.status === 410 ? { timestamp: Date.now() } : {}) }) : undefined);
  }

  private check({ headers, jwt, body }: FakeApnsRequest): string[] {
    const problems: string[] = [];
    const want = (ok: boolean, problem: string) => {
      if (!ok) problems.push(problem);
    };
    want(headers[":method"] === "POST", "not a POST");
    want(/^\/3\/device\/[0-9a-f]{64,200}$/.test(String(headers[":path"])), "path is not /3/device/<hex token>");
    want(headers["apns-topic"] === this.expected.topic, "wrong apns-topic");
    want(headers["apns-push-type"] === "alert", "apns-push-type is not alert");
    want(/^\d+$/.test(String(headers["apns-expiration"])), "no apns-expiration");
    const collapse = String(headers["apns-collapse-id"] ?? "");
    want(collapse.length > 0 && Buffer.byteLength(collapse) <= 64, "apns-collapse-id missing or over 64 bytes");
    want(Buffer.byteLength(body) <= 4096, "payload over 4096 bytes");
    const sensitive = ((headers as Record<symbol, unknown>)[http2.sensitiveHeaders] as string[] | undefined) ?? [];
    want(sensitive.includes("authorization") && sensitive.includes(":path"), "authorization and :path are not sent as sensitive");
    let payload: { aps?: Record<string, unknown> } = {};
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      problems.push("payload is not JSON");
    }
    const passive = payload.aps?.["interruption-level"] === "passive";
    want(headers["apns-priority"] === (passive ? "5" : "10"), "priority does not match the interruption level");
    want(jwt.header["alg"] === "ES256" && jwt.header["kid"] === this.expected.keyId, "token header is not ES256 with the key id");
    want(jwt.claims["iss"] === this.expected.teamId && Number.isInteger(jwt.claims["iat"]), "token claims lack the team id or iat");
    const [head, claims, signature] = jwt.raw.split(".");
    const signed = Buffer.from(signature ?? "", "base64url");
    want(signed.length === 64 && verify("sha256", Buffer.from(`${head}.${claims}`), { key: this.expected.publicKey, dsaEncoding: "ieee-p1363" }, signed), "token signature does not verify");
    return problems;
  }
}

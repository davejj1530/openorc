/**
 * A thread's first work from a Mac's folder, as the server takes it (`PUT /hosted/threads/:id/mac-work`): the pack is
 * the body, what it holds is the query. Behind the `macCode` capability, answered 409 with its reason while that is
 * not on, as the server does behind its switch. Each pack taken is kept, with how many messages its thread had then.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type TakenMacWork = { threadId: string; query: Record<string, string>; bytes: Buffer; messagesBefore: number };

export class StandInMacWork {
  readonly taken: TakenMacWork[] = [];

  constructor(private readonly deps: { available: () => boolean; messages: (threadId: string) => number }) {}

  async answer(request: IncomingMessage, response: ServerResponse, holder: (token: string) => string | null): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://stand-in");
    const [, threadId] = /^\/hosted\/threads\/([^/]+)\/mac-work$/.exec(url.pathname) ?? [];
    if (!threadId || request.method !== "PUT") return false;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const who = holder(/^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? "");
    const reply = this.#reply(who, decodeURIComponent(threadId), Object.fromEntries(url.searchParams), Buffer.concat(chunks));
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
    return true;
  }

  #reply(who: string | null, threadId: string, query: Record<string, string>, bytes: Buffer) {
    if (!who) return { status: 401, body: { statusCode: 401, message: "Unauthorized" } };
    if (!this.deps.available()) return { status: 409, body: { statusCode: 409, code: "feature_unavailable", message: "Code from this Mac isn't available in cloud threads yet." } };
    return this.#take(threadId, query, bytes);
  }

  #take(threadId: string, query: Record<string, string>, bytes: Buffer) {
    this.taken.push({ threadId, query, bytes, messagesBefore: this.deps.messages(threadId) });
    return { status: 200, body: { saved: true, bytes: bytes.length } };
  }
}

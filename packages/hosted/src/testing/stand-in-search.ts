import type { StandInThreads } from "./stand-in-threads.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
type Stored = { seq: number; event: { type: string; role?: string; text?: string; messageId?: string; ts?: number } };
type Listed = { id: string; title: string; projectId: string | null };

/**
 * The server's search of a person's cloud threads in a space (its hosted/search.ts), made of the stand-in's own reads:
 * the threads the person lists, and each one's log, so it finds exactly what they may read.
 */
export class StandInSearch {
  constructor(private readonly threads: Pick<StandInThreads, "route">) {}

  route(request: Request, who: string): Reply | null {
    if (request.method !== "GET" || request.path !== "/hosted/search") return null;
    const q = (request.query.get("q") ?? "").trim().toLowerCase();
    const limit = Number(request.query.get("limit") ?? 30);
    const read = (path: string, query = new URLSearchParams()) => this.threads.route({ method: "GET", path, query, space: request.space }, who);
    const listed = read("/hosted/threads");
    if (listed?.status !== 200) return listed;
    const hits = (listed.body as { threads: Listed[] }).threads.flatMap((thread) => {
      const events = (read(`/hosted/threads/${encodeURIComponent(thread.id)}/events`, new URLSearchParams({ after: "0", limit: "2000" }))?.body as { events: Stored[] }).events;
      return events.flatMap(({ seq, event }) => {
        if (event.type !== "message.completed" || (event.role !== "user" && event.role !== "assistant") || !event.text?.toLowerCase().includes(q)) return [];
        const turn = events.filter((each) => each.event.type === "turn.completed" && each.seq < seq).length;
        return [{ threadId: thread.id, title: thread.title, projectId: thread.projectId, messageId: event.messageId, turn, role: event.role, snippet: event.text, at: event.ts ?? 0 }];
      });
    });
    return { status: 200, body: { hits: hits.sort((a, b) => b.at - a.at).slice(0, limit) } };
  }
}

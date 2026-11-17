import type { StandInThreads } from "./stand-in-threads.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
type Stored = { seq: number; event: { type: string; role?: string; text?: string; messageId?: string; ts?: number } };
type Listed = { id: string; title: string; projectId: string | null };
type Note = { id: string; author: { id: string; name: string } | null; text: string; createdAt: string; afterEventSeq: number };

/**
 * The server's search of a person's cloud threads in a space (its hosted/search.ts), made of the stand-in's own reads:
 * the threads the person lists, and each one's log and notes, so it finds exactly what they may read. Notes are found
 * only for an app that asks for them (`notes=1`).
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
      const turnBefore = (seq: number) => events.filter((each) => each.event.type === "turn.completed" && each.seq < seq).length;
      const where = { threadId: thread.id, title: thread.title, projectId: thread.projectId };
      const messages = events.flatMap(({ seq, event }) => {
        if (event.type !== "message.completed" || (event.role !== "user" && event.role !== "assistant") || !event.text?.toLowerCase().includes(q)) return [];
        return [{ ...where, messageId: event.messageId, turn: turnBefore(seq), role: event.role, snippet: event.text, at: event.ts ?? 0 }];
      });
      if (request.query.get("notes") !== "1") return messages;
      const notes = (read(`/hosted/threads/${encodeURIComponent(thread.id)}/notes`, new URLSearchParams({ limit: "200" }))?.body as { notes?: Note[] } | undefined)?.notes ?? [];
      return [
        ...messages,
        ...notes
          .filter((note) => note.text.toLowerCase().includes(q))
          .map((note) => ({
            ...where,
            messageId: note.id,
            turn: turnBefore(note.afterEventSeq),
            role: "note",
            snippet: note.text,
            at: Date.parse(note.createdAt),
            author: note.author && { id: note.author.id, name: note.author.name },
          })),
      ];
    });
    return { status: 200, body: { hits: hits.sort((a, b) => b.at - a.at).slice(0, limit) } };
  }
}

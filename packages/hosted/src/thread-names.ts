import type { HostedDeps } from "./index.js";
import { READ_LIMIT } from "./follow.js";
import type { Requests } from "./session.js";
import { toAppEvent } from "./translate.js";
import { ROUTES, type WireThread } from "./wire.js";

type Visit = { head: number; pending: boolean; done: boolean };
type Deps = Pick<HostedDeps, "nameThread" | "log"> & { on(id: string): Requests; saved(row: WireThread): void };

/** Read the first exchange once it is complete, including turns that ended while this device was away. */
export class ThreadNames {
  readonly #visits = new Map<string, Visit>();
  #rows = new Map<string, WireThread>();

  constructor(private readonly deps: Deps) {}

  refresh(rows: readonly WireThread[], me: string | null): void {
    this.#rows = new Map(rows.map((row) => [row.id, row]));
    for (const id of this.#visits.keys()) if (!this.#rows.has(id)) this.#visits.delete(id);
    if (me && this.deps.nameThread) for (const row of rows) if (row.createdBy === me && row.lastAgentSeq > 0) this.#consider(row, me);
  }

  clear(): void {
    this.#rows.clear();
    this.#visits.clear();
  }

  #consider(row: WireThread, me: string): void {
    const previous = this.#visits.get(row.id);
    if (previous && (previous.pending || previous.done || previous.head === row.head)) return;
    const visit: Visit = { head: row.head, pending: true, done: false };
    this.#visits.set(row.id, visit);
    void this.#name(row, me, visit)
      .catch((error: unknown) => {
        if (this.#visits.get(row.id) !== visit) return;
        this.#visits.delete(row.id);
        this.deps.log.warn(`OpenOrc Cloud title: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        visit.pending = false;
        const current = this.#rows.get(row.id);
        if (current && current.head !== row.head) this.#consider(current, me);
      });
  }

  async #name(row: WireThread, me: string, visit: Visit): Promise<void> {
    const on = this.deps.on(row.id);
    const detail = await on.request(ROUTES.thread(row.id));
    const end = detail.turnEnds[0];
    if (!end) return;
    const exchange = await firstExchange(on, row.id, end, me);
    if (this.#visits.get(row.id) !== visit) return;
    visit.done = true;
    if (!exchange) return;
    const named = await this.deps.nameThread?.({ id: row.id, title: detail.title, agent: row.settings.agent }, exchange);
    if (!named || this.#visits.get(row.id) !== visit) return;
    const saved = await on.request(ROUTES.update(row.id), named);
    if (this.#visits.get(row.id) === visit) this.deps.saved(saved);
  }
}

/** Stop at the first completion, even when several turns arrived before the catalog was read. */
async function firstExchange(on: Requests, id: string, end: number, me: string): Promise<{ prompt: string; reply: string | null } | null> {
  let after = 0;
  let prompt: string | null = null;
  let reply: string | null = null;
  while (after < end) {
    const page = await on.request(ROUTES.events(id, { after }, Math.min(READ_LIMIT, end - after)));
    if (!page.events.length) return null;
    for (const stored of page.events) {
      if (stored.seq > end) break;
      const event = toAppEvent(id, stored);
      if (event.type === "message.completed" && event.role === "user" && prompt === null) {
        if (stored.by !== me) return null;
        prompt = event.text;
      }
      if (event.type === "message.completed" && event.role === "assistant") reply = event.text;
      if (event.type === "turn.completed") return prompt === null ? null : { prompt, reply: event.resultText ?? reply };
    }
    const next = page.events.at(-1)!.seq;
    if (next <= after) return null;
    after = next;
  }
  return null;
}

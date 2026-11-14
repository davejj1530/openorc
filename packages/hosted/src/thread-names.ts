import { z } from "zod";
import type { HostedDeps } from "./index.js";
import { READ_LIMIT } from "./follow.js";
import type { Requests } from "./session.js";
import { toAppEvent } from "./translate.js";
import { ROUTES, type WireEvent, type WireThread } from "./wire.js";

export const TITLE_DISCOVERY_MS = 7 * 24 * 60 * 60_000;
export const TITLE_RETRY_MS = 60_000;
export const keptThreadNames = z.record(
  z.string(),
  z.discriminatedUnion("state", [z.object({ state: z.literal("examined") }), z.object({ state: z.literal("waiting"), head: z.number() }), z.object({ state: z.literal("retry"), after: z.number() })]),
);
type Visits = z.infer<typeof keptThreadNames>;
type Deps = Pick<HostedDeps, "nameThread" | "now" | "log"> & { on(id: string): Requests; saved(row: WireThread): void; keep(): void };

/** Discover recent first exchanges serially; completed checks belong to the account's kept cache. */
export class ThreadNames {
  #visits: Visits = {};
  #rows = new Map<string, WireThread>();
  #me: string | null = null;
  #generation = 0;
  #running = false;
  readonly #firstEnds = new Map<string, number | null>();
  readonly #liveEnds = new Map<string, number>();
  readonly #live = new Set<string>();

  constructor(private readonly deps: Deps) {}

  refresh(rows: readonly WireThread[], me: string | null, visits: Visits): void {
    this.#rows = new Map(rows.map((row) => [row.id, row]));
    this.#me = me;
    this.#visits = visits;
    this.#drain();
  }

  /** Reuse the conversation's own page to know whether a watched completion is its first. */
  observed(id: string, events: readonly WireEvent[], fromTurn: number): void {
    if (this.#visits[id]?.state === "examined") return;
    this.#firstEnds.set(id, fromTurn > 0 ? 0 : (events.find((entry) => entry.event["type"] === "turn.completed")?.seq ?? null));
    this.#considerLive(id);
  }

  completed(id: string, seq: number): void {
    if (this.#visits[id]?.state === "examined") return;
    this.#liveEnds.set(id, seq);
    this.#considerLive(id);
  }

  #considerLive(id: string): void {
    const first = this.#firstEnds.get(id);
    const live = this.#liveEnds.get(id);
    if (live === undefined || first === undefined || (first !== null && first !== live)) return;
    this.#firstEnds.set(id, live);
    this.#live.add(id);
    this.#drain();
  }

  clear(): void {
    this.#generation++;
    this.#rows.clear();
    this.#visits = {};
    this.#me = null;
    this.#firstEnds.clear();
    this.#liveEnds.clear();
    this.#live.clear();
  }

  #eligible(row: WireThread): boolean {
    if (row.createdBy !== this.#me) return false;
    const visit = this.#visits[row.id];
    if (visit?.state === "examined" || (visit?.state === "retry" && visit.after > this.deps.now())) return false;
    if (visit?.state === "waiting" && visit.head === row.head && !this.#live.has(row.id)) return false;
    if (this.#live.has(row.id)) return true;
    return Date.parse(row.createdAt) >= this.deps.now() - TITLE_DISCOVERY_MS && row.lastAgentSeq > 0 && !row.turn && row.status !== "working";
  }

  #drain(): void {
    if (this.#running || !this.#me || !this.deps.nameThread) return;
    const row = [...this.#rows.values()]
      .filter((each) => this.#eligible(each))
      .sort((a, b) => Number(this.#live.has(b.id)) - Number(this.#live.has(a.id)) || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!row) return;
    const generation = this.#generation;
    this.#running = true;
    void this.#name(row, this.#me, generation)
      .catch((error: unknown) => {
        if (generation !== this.#generation) return;
        this.#visits[row.id] = { state: "retry", after: this.deps.now() + TITLE_RETRY_MS };
        this.deps.keep();
        this.deps.log.warn(`OpenOrc Cloud title: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#running = false;
        this.#drain();
      });
  }

  async #name(row: WireThread, me: string, generation: number): Promise<void> {
    const on = this.deps.on(row.id);
    const detail = await on.request(ROUTES.thread(row.id));
    if (generation !== this.#generation) return;
    const end = detail.turnEnds[0];
    if (!end) {
      this.#visits[row.id] = { state: "waiting", head: row.head };
      return this.deps.keep();
    }
    const exchange = await firstExchange(on, row.id, end, me);
    if (generation !== this.#generation) return;
    const named = exchange && (await this.deps.nameThread?.({ id: row.id, title: detail.title, agent: row.settings.agent }, exchange));
    if (generation !== this.#generation) return;
    if (named) {
      const saved = await on.request(ROUTES.update(row.id), named);
      if (generation !== this.#generation) return;
      this.deps.saved(saved);
    }
    this.#visits[row.id] = { state: "examined" };
    this.#live.delete(row.id);
    this.#liveEnds.delete(row.id);
    this.#firstEnds.delete(row.id);
    this.deps.keep();
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

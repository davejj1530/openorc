/**
 * A person's own cloud connectors, as the server keeps them: one per agent and name, header values sealed and never
 * read back, a save naming the headers to keep. While the `httpsConnectors` capability is not on, every route answers
 * 409 with its reason, as the server does behind its switch. A check answers what `answers` says for the address,
 * connected unless told otherwise; nothing is asked of any network.
 */
type Reply = { status: number; body: unknown };
type Request = { method: string; path: string };
type Kept = { agent: string; name: string; url: string; headers: Map<string, { value: string; updatedAt: string }>; revision: number; updatedAt: string };
type Check = { status: "connected" | "refused" | "failed"; message: string | null };

const OFF = "Your connectors aren't available in cloud threads yet.";
const refused = (status: number, message: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { statusCode: status, message, ...extra } });

export class StandInConnectors {
  /** Each person's connectors, by `agent/name`. */
  readonly #kept = new Map<string, Map<string, Kept>>();
  /** What a check of an address answers here, by address. */
  readonly answers = new Map<string, Check>();

  constructor(private readonly deps: { available: () => boolean }) {}

  /** A header value as it was saved for a person's connector, for a test to see what the server was given. */
  saved(who: string, agent: string, name: string, header: string): string | undefined {
    return this.#kept.get(who)?.get(`${agent}/${name}`)?.headers.get(header)?.value;
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    const [, agent, name, check] = /^\/hosted\/connectors(?:\/([^/]+)\/([^/]+)(\/check)?)?$/.exec(request.path) ?? [];
    if (!request.path.startsWith("/hosted/connectors")) return null;
    if (!this.deps.available()) return refused(409, OFF, { code: "feature_unavailable" });
    const mine = this.#kept.get(who) ?? new Map<string, Kept>();
    this.#kept.set(who, mine);
    if (!agent && request.method === "GET") return this.#listed(mine);
    if (!agent || !name) return refused(404, `Cannot ${request.method} ${request.path}`);
    const key = `${decodeURIComponent(agent)}/${decodeURIComponent(name)}`;
    const found = mine.get(key);
    if (check && request.method === "POST") {
      if (!found) return refused(404, "That connector isn't here.");
      return { status: 200, body: this.answers.get(found.url) ?? { status: "connected", message: null } };
    }
    if (request.method === "DELETE") {
      if (!found) return refused(404, "That connector isn't here.");
      mine.delete(key);
      return this.#listed(mine);
    }
    if (request.method === "PUT") return this.#put(mine, key, found, body);
    return refused(404, `Cannot ${request.method} ${request.path}`);
  }

  #put(mine: Map<string, Kept>, key: string, found: Kept | undefined, body: unknown): Reply {
    const input = body as { url?: string; headers?: ({ name: string; value: string } | { name: string; keep: true })[] } | null;
    if (!input?.url?.startsWith("https://")) return refused(400, "url: A connector in the cloud is reached over HTTPS.");
    const now = new Date().toISOString();
    const headers = new Map<string, { value: string; updatedAt: string }>();
    for (const header of input.headers ?? []) {
      const name = header.name.toLowerCase();
      const kept = "keep" in header ? found?.headers.get(name) : { value: header.value, updatedAt: now };
      if (!kept) return refused(400, `${name} has no saved value to keep. Give it one.`);
      headers.set(name, kept);
    }
    const [agent = "", name = ""] = key.split("/");
    const saved: Kept = { agent, name, url: input.url, headers, revision: (found?.revision ?? 0) + 1, updatedAt: now };
    mine.set(key, saved);
    return { status: 200, body: this.#wire(saved) };
  }

  #wire(one: Kept) {
    return { agent: one.agent, name: one.name, url: one.url, headers: [...one.headers].map(([name, { updatedAt }]) => ({ name, updatedAt })), revision: one.revision, updatedAt: one.updatedAt };
  }

  #listed(mine: Map<string, Kept>): Reply {
    return { status: 200, body: { connectors: [...mine.values()].map((one) => this.#wire(one)) } };
  }
}

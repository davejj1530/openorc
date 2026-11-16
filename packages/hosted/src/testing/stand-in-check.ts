import { CLOUD_CHECK_STEPS } from "@openorc/protocol";
import type { WireCheckReply } from "../wire-check.js";

/**
 * A person's cloud check, as a server with the check runs it: a start answers every link running, and `finish` lands
 * them. A server from before the check has no such route: `present` false, every request gets the 404 an unknown
 * route does. Past `limit` starts it answers 429 in words.
 */
type Reply = { status: number; body: unknown };
type Check = NonNullable<WireCheckReply["check"]>;

export class StandInCheck {
  present = false;
  limit = 6;
  readonly #kept = new Map<string, Check>();
  readonly #starts = new Map<string, number>();
  /** Which space each start was asked in. */
  readonly spaces: (string | null)[] = [];

  /** Lands every link of the person's check: ok, but those named broken with their words. */
  finish(who: string, broken: Partial<Record<Check["links"][number]["step"], string>> = {}): void {
    const check = this.#kept.get(who);
    if (!check) return;
    const links = check.links.map((link) => ({ ...link, state: broken[link.step] ? ("broken" as const) : ("ok" as const), words: broken[link.step] ?? null, ms: 120 }));
    this.#kept.set(who, { ...check, links, done: true, broken: links.find((link) => link.state === "broken")?.step ?? null });
  }

  route(request: { method: string; path: string; space: string | null }, who: string): Reply | null {
    if (!this.present || request.path !== "/hosted/check") return null;
    if (request.method === "GET") return { status: 200, body: { check: this.#kept.get(who) ?? null } };
    if (request.method !== "POST") return null;
    const starts = (this.#starts.get(who) ?? 0) + 1;
    this.#starts.set(who, starts);
    if (starts > this.limit) return { status: 429, body: { statusCode: 429, message: "That's a lot of checks at once. Try again in 60 seconds." } };
    this.spaces.push(request.space);
    const check: Check = {
      id: `check-${starts}`,
      startedAt: new Date().toISOString(),
      done: false,
      service: "Vercel",
      links: CLOUD_CHECK_STEPS.map((step) => ({ step, state: "running", words: null, ms: null })),
      broken: null,
    };
    this.#kept.set(who, check);
    return { status: 200, body: { check } };
  }
}

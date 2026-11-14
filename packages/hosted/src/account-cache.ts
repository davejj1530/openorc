import { z } from "zod";
import type { HostedDeps, KeptPart } from "./index.js";

/** Nonsecret snapshots are separated by server and stable account identity. */
export class AccountCache<T> {
  readonly #schema: z.ZodType<{ apiOrigin: string; userId: string; email: string; data: T }[]>;
  readonly #origin: string;
  constructor(private readonly deps: { kept: HostedDeps["kept"]; part: KeptPart; server: string; schema: z.ZodType<T> }) {
    this.#origin = new URL(deps.server).origin;
    this.#schema = z.array(z.object({ apiOrigin: z.string(), userId: z.string(), email: z.string(), data: deps.schema }));
  }
  private records() {
    try {
      return this.#schema.parse(JSON.parse(this.deps.kept.load(this.deps.part) ?? "[]"));
    } catch {
      return [];
    }
  }
  load(email: string): T | null {
    return this.records().find((record) => record.apiOrigin === this.#origin && record.email === email)?.data ?? null;
  }
  save(userId: string | null, email: string, data: T): void {
    if (!userId) return;
    const others = this.records().filter((record) => record.apiOrigin !== this.#origin || record.userId !== userId);
    this.deps.kept.save(this.deps.part, JSON.stringify([...others, { apiOrigin: this.#origin, userId, email, data }]));
  }
  forget(userId: string | null): void {
    if (!userId) return;
    const others = this.records().filter((record) => record.apiOrigin !== this.#origin || record.userId !== userId);
    this.deps.kept.save(this.deps.part, others.length ? JSON.stringify(others) : null);
  }
}

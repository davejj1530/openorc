import type { CloudBrainCost } from "@openorc/protocol";

/** Vercel is asked again only after this long, however often Settings looks. */
const READ_MS = 10 * 60_000;

/** The first moment of the month `now` is in, on this Mac's clock, as a person reads "this month". */
export function monthStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** The brain's cost this month, asked of Vercel at most every ten minutes and once at a time; a read that fails shows none. */
export class BrainCosts {
  private last: { at: number; since: number; cost: CloudBrainCost | null } | null = null;
  private asking: Promise<CloudBrainCost | null> | null = null;

  read(now: number, ask: (since: number) => Promise<number | null>): Promise<CloudBrainCost | null> {
    const since = monthStart(now);
    if (this.last && this.last.since === since && now - this.last.at < READ_MS) return Promise.resolve(this.last.cost);
    this.asking ??= ask(since)
      .catch(() => null)
      .then((usd) => {
        const cost = usd === null ? null : { usd, since };
        this.last = { at: now, since, cost };
        return cost;
      })
      .finally(() => (this.asking = null));
    return this.asking;
  }
}

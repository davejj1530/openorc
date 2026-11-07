/** One snapshot as Vercel lists it for a project. */
export interface ListedSnapshot {
  id: string;
  /** The snapshot the session that made this one started from. */
  parentId?: string | undefined;
  status: "created" | "deleted" | "failed";
  sizeBytes: number;
  createdAt: number;
  expiresAt?: number | undefined;
  lastUsedAt?: number | undefined;
}

/** Vercel's list price for snapshot storage, the same in every region (vercel.com/docs/sandbox/pricing, 2026-11-04). */
const USD_PER_GB_MONTH = 0.08;
/** Vercel's charges prorate a GB-month over 730 hours. */
const MONTH_MS = 730 * 3_600_000;

/**
 * Until when a snapshot was kept, at least. A deleted one counts until the snapshot made two sessions later (the brain
 * keeps its last two, so that one replaced it), else its child, else its last use.
 */
function keptUntil(snapshot: ListedSnapshot, children: Map<string, ListedSnapshot[]>, now: number): number {
  if (snapshot.status === "created") return Math.min(now, snapshot.expiresAt ?? now);
  const childs = children.get(snapshot.id) ?? [];
  const later = [...childs, ...childs.flatMap((child) => children.get(child.id) ?? [])].map((each) => each.createdAt);
  const until = Math.max(snapshot.lastUsedAt ?? snapshot.createdAt, ...later);
  return Math.min(now, snapshot.expiresAt ?? now, until);
}

/**
 * What a project's snapshots cost to keep from `since` to `now`, at Vercel's list price, from what the list says. Vercel
 * lists no deletion time, so this is at least what they cost; billedSnapshots has its own count for the days it closed.
 */
export function snapshotStorageCost(snapshots: readonly ListedSnapshot[], since: number, now: number): number {
  const children = new Map<string, ListedSnapshot[]>();
  for (const snapshot of snapshots) if (snapshot.parentId) children.set(snapshot.parentId, [...(children.get(snapshot.parentId) ?? []), snapshot]);
  return snapshots.reduce((usd, snapshot) => {
    if (snapshot.status === "failed") return usd;
    const kept = keptUntil(snapshot, children, now) - Math.max(snapshot.createdAt, since);
    return kept > 0 ? usd + (snapshot.sizeBytes / 1e9) * (kept / MONTH_MS) * USD_PER_GB_MONTH : usd;
  }, 0);
}

/** A line of Vercel's FOCUS billing charges, the parts read here. */
interface Charge {
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ServiceName: string;
  ConsumedQuantity: number | null;
  Tags?: { ProjectId?: string };
}

/**
 * The snapshot storage Vercel charged one project from `since` on, at list price, from the team's daily charges (JSONL):
 * each day's gigabytes kept, for the part of the day after `since`. Vercel writes a day for a project with sandboxes even
 * when it kept none, so `until`, the end of its last day, is where the list takes over.
 */
export function billedSnapshots(jsonl: string, projectId: string, since: number): { usd: number; until: number } {
  let usd = 0;
  let until = since;
  // A month of a team's charges runs to megabytes: only this project's snapshot lines are read.
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"Snapshot Storage"') || !line.includes(projectId)) continue;
    const charge = JSON.parse(line) as Charge;
    const [start, end] = [Date.parse(charge.ChargePeriodStart), Date.parse(charge.ChargePeriodEnd)];
    if (charge.ServiceName !== "Snapshot Storage" || charge.Tags?.ProjectId !== projectId || end <= since) continue;
    until = Math.max(until, end);
    usd += (charge.ConsumedQuantity ?? 0) * ((end - Math.max(start, since)) / MONTH_MS) * USD_PER_GB_MONTH;
  }
  return { usd, until };
}

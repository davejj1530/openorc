import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceLease {
  readonly id: string;
  readonly owner: string;
  readonly paths: readonly string[];
  /** Idempotent. Inherited holders keep the reservation until they also release. */
  release(): void;
}

interface Reservation {
  id: string;
  owner: string;
  paths: readonly string[];
  holders: number;
  shared: boolean;
}

/** Whether two reservation path sets touch the same directory tree. */
export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((root) => b.some((target) => contains(root, target) || contains(target, root)));
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve missing worktrees through their nearest existing physical ancestor. */
async function canonical(input: string): Promise<string> {
  if (!input.trim()) throw new Error("A workspace reservation needs a path.");
  let current = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Another launch may create this path between realpath and lstat.
      const existing = await lstat(current).catch((failure: unknown) => {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
        return null;
      });
      if (existing) {
        try {
          return path.join(await realpath(current), ...missing);
        } catch (cause) {
          // Still reject dangling symlinks; never guess an existing path's identity.
          throw new Error(`Workspace path ${current} cannot be resolved.`, { cause });
        }
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export interface AcquireOptions {
  /** Agent sessions may work in the same directory concurrently; exclusive operations still conflict with them. */
  shared?: boolean;
  /** Exclusive work on a shared team workspace waits for the members' turns to end instead of failing. The callback aborts the wait. */
  waitForShared?: () => void;
  /**
   * The mirror image: a member joining a shared workspace waits for a short exclusive operation there (an output
   * capture, an input preparation, an integration) instead of failing to start. The callback aborts the wait.
   * Waiting holds no reservation, and every exclusive holder of a shared path releases after one Git operation,
   * so the two waits cannot close a cycle.
   */
  waitForExclusive?: () => void;
  /** Upper bound for either wait; the default is ten minutes. */
  maxWaitMs?: number;
}

/** Concurrent agent sessions share directory trees; workspace mutations reserve them exclusively. */
export class WorkspaceWriters {
  private readonly reservations = new Map<string, Reservation>();
  private readonly leases = new WeakMap<WorkspaceLease, { reservation: Reservation; released: boolean }>();
  private yielding: ((paths: readonly string[]) => Promise<boolean>) | null = null;
  private report: ((message: string) => void) | null = null;
  private yieldable: ((leaseId: string) => boolean) | null = null;

  /** Registers who can free a directory held by idle work: returns true when the holder released it and the claim should be retried. */
  onConflict(handler: (paths: readonly string[]) => Promise<boolean>, report?: (message: string) => void, yieldable?: (leaseId: string) => boolean): void {
    this.yielding = handler;
    this.report = report ?? null;
    this.yieldable = yieldable ?? null;
  }

  /** Read-only availability; acquire still makes the authoritative atomic check. */
  async reason(paths: readonly string[]): Promise<string | null> {
    const resolved = await Promise.all(paths.map(canonical));
    const conflict = [...this.reservations.values()].find((reservation) => overlaps(reservation.paths, resolved) && !this.yieldable?.(reservation.id));
    return conflict ? `Workspace is in use by ${conflict.owner}. Finish or stop that operation before applying changes.` : null;
  }

  async acquire(paths: string | readonly string[], owner: string, inherited?: WorkspaceLease, options: AcquireOptions = {}): Promise<WorkspaceLease> {
    const inputs = typeof paths === "string" ? [paths] : paths;
    if (!inputs.length) throw new Error("A workspace reservation needs at least one path.");
    const resolved = [...new Set(await Promise.all(inputs.map(canonical)))].sort();
    // No awaits after identity resolution: checking and claiming all paths is atomic.
    if (inherited) {
      const held = this.leases.get(inherited);
      if (!held || held.released || !this.reservations.has(held.reservation.id)) throw new Error("The workspace reservation has already been released or belongs to another host.");
      if (resolved.some((target) => !held.reservation.paths.some((root) => contains(root, target)))) throw new Error("The inherited workspace reservation does not cover this operation's paths.");
      return this.hold(held.reservation, resolved);
    }
    const waitedFrom = Date.now();
    let yielded = false;
    let announced = false;
    for (;;) {
      const overlapping = [...this.reservations.values()].filter((reservation) => overlaps(reservation.paths, resolved));
      const conflict = overlapping.find((reservation) => !options.shared || !reservation.shared);
      if (!conflict) {
        if (announced) this.report?.(`${owner} acquired ${resolved.join(", ")} after waiting ${Date.now() - waitedFrom} ms`);
        break;
      }
      const waiting = conflict.shared ? options.waitForShared : options.waitForExclusive;
      if (!announced && waiting) {
        announced = true;
        this.report?.(`${owner} waits for ${conflict.owner} to release ${resolved.join(", ")}`);
      }
      // A process waiting between turns gives the directory up; its session resumes when it is next needed.
      if (!yielded && this.yielding) {
        yielded = true;
        if (await this.yielding(resolved)) continue;
      }
      if (!waiting || Date.now() - waitedFrom > (options.maxWaitMs ?? 600_000)) {
        const file = resolved.find((target) => conflict.paths.some((root) => contains(root, target) || contains(target, root)))!;
        throw new Error(`Workspace ${file} is in use by ${conflict.owner}. Finish or stop that operation before ${owner}.`);
      }
      waiting();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Independent sessions need independent identities: one idle session must not
    // make a busy session's reservation appear yieldable. Only inheritance shares holders.
    const reservation: Reservation = { id: randomUUID(), owner, paths: Object.freeze(resolved), holders: 0, shared: Boolean(options.shared) };
    this.reservations.set(reservation.id, reservation);
    return this.hold(reservation, resolved);
  }

  async withLease<T>(paths: string | readonly string[], owner: string, operation: (lease: WorkspaceLease) => Promise<T>, inherited?: WorkspaceLease, options: AcquireOptions = {}): Promise<T> {
    const lease = await this.acquire(paths, owner, inherited, options);
    try {
      return await operation(lease);
    } finally {
      lease.release();
    }
  }

  private hold(reservation: Reservation, paths: readonly string[]): WorkspaceLease {
    reservation.holders++;
    const state = { reservation, released: false };
    const lease: WorkspaceLease = Object.freeze({
      id: reservation.id,
      owner: reservation.owner,
      paths: Object.freeze(paths),
      release: () => {
        if (state.released) return;
        state.released = true;
        if (--reservation.holders === 0) this.reservations.delete(reservation.id);
      },
    });
    this.leases.set(lease, state);
    return lease;
  }
}

/** Backward-compatible direct constructors share the same process reservation table. */
export const workspaceWriters = new WorkspaceWriters();

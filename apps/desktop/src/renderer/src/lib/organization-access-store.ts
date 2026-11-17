import type { OrganizationAccess, Space, SpacesStatus } from "@openorc/protocol";
import { organizationAccessAt } from "@openorc/client";

export interface OrganizationGateSnapshot {
  identity: string | null;
  ready: boolean;
  spaces: readonly Space[];
  access: OrganizationAccess | undefined;
  generation: number;
  error: string | null;
}
export interface OrganizationContentState {
  allowed: boolean;
  blocked: "loading" | "membership" | "unknown" | "frozen" | null;
  space: Space | null;
  access: OrganizationAccess | undefined;
  identity: string | null;
  generation: number;
  error: string | null;
}
export interface OrganizationProtectionChange {
  reason: "frozen" | "membership" | "account" | "authority";
  spaceIds: string[];
  removed: string[];
  generation: number;
}
export interface OrganizationAccessStoreDeps {
  now(): number;
  read(): Promise<SpacesStatus>;
}

export class OrganizationAccessStore {
  #snapshot: OrganizationGateSnapshot = { identity: null, ready: false, spaces: [], access: undefined, generation: 0, error: null };
  readonly #listeners = new Set<() => void>();
  readonly #protected = new Set<(change: OrganizationProtectionChange) => void>();
  #read = 0;
  #fence = 0;
  #heardAt = 0;
  #closedAt = 0;
  #accountId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  constructor(private readonly deps: OrganizationAccessStoreDeps) {}

  getSnapshot = (): OrganizationGateSnapshot => {
    this.#expire();
    return this.#snapshot;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  /** Clear bodies, rosters and protected caches synchronously. Private drafts belong to their consumer. */
  subscribeProtected = (listener: (change: OrganizationProtectionChange) => void): (() => void) => {
    this.#protected.add(listener);
    return () => this.#protected.delete(listener);
  };

  status(spaceId: string | null): OrganizationContentState {
    return organizationContentState(this.getSnapshot(), spaceId);
  }

  /** A captured content response remains invalid after a freeze and later recovery. */
  capture(spaceId: string | null, expectedAccountId?: string) {
    const captured = this.status(spaceId);
    const matches = expectedAccountId === undefined || this.#accountId === expectedAccountId;
    return {
      generation: captured.generation,
      current: () => {
        const current = this.status(spaceId);
        return matches && captured.allowed && current.allowed && current.identity === captured.identity && current.generation === captured.generation;
      },
    };
  }

  /**
   * The person is leaving or deleting an organization: its content closes now, so nothing mounted under it reads it again
   * on the way out. A refresh opens it again while they are still in it.
   */
  close(spaceId: string): void {
    if (this.#disposed) return;
    this.#publish({ ...this.#snapshot, spaces: this.#snapshot.spaces.filter((space) => space.id !== spaceId) });
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#expire();
    const reading = ++this.#read;
    const fence = this.#fence;
    const started = this.deps.now();
    try {
      const status = await this.deps.read();
      if (this.#disposed || reading !== this.#read || fence !== this.#fence) return;
      this.#accept(status, started);
    } catch (error) {
      if (this.#disposed || reading !== this.#read || fence !== this.#fence) return;
      this.#publish({ ...this.#snapshot, error: error instanceof Error ? error.message : "Organization access could not be checked." });
    }
  }

  #accept(status: SpacesStatus, started: number): void {
    if (status.state === "loading") {
      this.#publish({ ...this.#snapshot, error: status.error });
      return;
    }
    if (status.state !== "ready") {
      this.reset();
      return;
    }
    if (!this.#snapshot.ready && status.heardAt < started) {
      this.#publish({ ...this.#snapshot, error: status.error ?? "Organization access could not be checked." });
      return;
    }
    const identity = gateIdentity(status);
    const same = identity === this.#snapshot.identity;
    if (same && status.heardAt < this.#heardAt) return;
    if (!same) this.#closedAt = 0;
    this.#heardAt = status.heardAt;
    this.#accountId = status.userId;
    let access = organizationAccessAt(status.organizationAccess, this.deps.now());
    if (same && this.#closedAt > status.heardAt && admits(access)) access = this.#snapshot.access;
    this.#publish({ identity, ready: true, spaces: status.spaces, access, error: status.error, generation: this.#snapshot.generation });
  }

  #expire(): boolean {
    const access = this.#snapshot.access;
    if (this.#disposed || access?.state !== "grace" || this.deps.now() < access.until) return false;
    this.#closedAt = access.until;
    ++this.#read;
    this.#publish({ ...this.#snapshot, access: organizationAccessAt(access, this.deps.now()) });
    return true;
  }

  #publish(next: OrganizationGateSnapshot): void {
    const before = this.#snapshot;
    const changed = authority(before) !== authority(next);
    if (changed) {
      ++this.#fence;
      next = { ...next, generation: before.generation + 1 };
    }
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    this.#snapshot = next;
    this.#deadline();
    const protection = changed ? protectionChange(before, next) : null;
    if (protection)
      for (const listener of this.#protected) {
        try {
          listener(protection);
        } catch (error) {
          console.error("An organization cache could not be cleared.", error);
        }
      }
    for (const listener of this.#listeners) listener();
  }

  #deadline(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const access = this.#snapshot.access;
    if (access?.state !== "grace") return;
    this.#timer = setTimeout(
      () => {
        if (this.#expire()) {
          if (this.#snapshot.ready) void this.refresh();
        } else this.#deadline();
      },
      Math.min(Math.max(0, access.until - this.deps.now()), 2_147_483_647),
    );
  }

  /** No membership departure is inferred while the window has stopped listening for changes. */
  suspend(): void {
    ++this.#read;
    ++this.#fence;
    this.#publish({ ...this.#snapshot, ready: false });
  }

  reset(): void {
    ++this.#read;
    ++this.#fence;
    this.#heardAt = 0;
    this.#closedAt = 0;
    this.#accountId = null;
    this.#publish({ identity: null, ready: false, spaces: [], access: undefined, generation: this.#snapshot.generation, error: null });
  }

  dispose(): void {
    this.reset();
    this.#disposed = true;
    this.#listeners.clear();
    this.#protected.clear();
    if (this.#timer) clearTimeout(this.#timer);
  }
}

/** The account a gate snapshot speaks for, as its `identity` names it. */
export const gateIdentity = (status: { apiOrigin: string; userId: string }): string => JSON.stringify([status.apiOrigin, status.userId]);
const admits = (access: OrganizationAccess | undefined): boolean => access?.state === "active" || access?.state === "grace";
const authority = (snapshot: OrganizationGateSnapshot): string =>
  JSON.stringify([snapshot.identity, snapshot.ready, admits(snapshot.access), snapshot.spaces.map((space) => [space.id, space.kind, space.kind === "organization" ? space.role : null])]);

export function organizationContentState(snapshot: OrganizationGateSnapshot, spaceId: string | null): OrganizationContentState {
  const space = snapshot.spaces.find((space) => space.id === spaceId) ?? null;
  let blocked: OrganizationContentState["blocked"] = null;
  if (spaceId !== null && space?.kind !== "personal") {
    if (!snapshot.ready) blocked = "loading";
    else if (!space) blocked = "membership";
    else if (!snapshot.access) blocked = "unknown";
    else if (snapshot.access.state === "frozen") blocked = "frozen";
  }
  return { allowed: blocked === null, blocked, space, identity: snapshot.identity, generation: snapshot.generation, access: snapshot.access, error: snapshot.error };
}

function protectionChange(before: OrganizationGateSnapshot, next: OrganizationGateSnapshot): OrganizationProtectionChange | null {
  const previous = before.spaces.filter((space) => space.kind === "organization");
  if (!previous.length) return null;
  const removed = previous.filter((space) => !next.spaces.some((now) => now.id === space.id)).map((space) => space.id);
  let reason: OrganizationProtectionChange["reason"] = "authority";
  if (before.identity !== next.identity) reason = "account";
  else if (removed.length) reason = "membership";
  else if (next.access?.state === "frozen") reason = "frozen";
  return { reason, spaceIds: previous.map((space) => space.id), removed, generation: next.generation };
}

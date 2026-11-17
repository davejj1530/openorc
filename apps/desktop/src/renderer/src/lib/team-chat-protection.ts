import { TeamChatGeneration } from "@openorc/client";
import type { SpacesStatus } from "@openorc/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { OrganizationAccessStore } from "./organization-access-store";
import type { TeamChatDrafts } from "@openorc/client";
import type { TeamChatClosedGroups } from "./team-chat-closed-groups";
import type { TeamChatContextValue } from "./team-chat-context";
import type { spaceNavigation } from "./space-navigation";

interface Dependencies {
  gate: OrganizationAccessStore;
  navigation: Pick<typeof spaceNavigation, "getState" | "subscribe">;
  queries: QueryClient;
  drafts: TeamChatDrafts;
  closedGroups: TeamChatClosedGroups;
  fileDrafts: { forgetSpace(accountId: string, spaceId: string): void };
}

/** Chat leases combine the shared account authority with this window's selected space. */
export class TeamChatProtection {
  readonly #leases = new TeamChatGeneration();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #accountId: string | null = null;
  #scope: TeamChatContextValue | null = null;
  constructor(private readonly deps: Dependencies) {}

  getSnapshot = (): number => this.#revision;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  connect(): () => void {
    const { gate, navigation, queries, drafts } = this.deps;
    const clear = () => {
      this.#leases.enter(null);
      this.#scope = null;
      queries.removeQueries({ queryKey: ["team-chat"] });
      ++this.#revision;
      for (const listener of this.#listeners) listener();
    };
    const protectedChange = gate.subscribeProtected((change) => {
      const accountId = this.#accountId;
      clear();
      if (!accountId) return;
      const removed = change.reason === "account" ? change.spaceIds : change.removed;
      for (const spaceId of removed) {
        drafts.forgetSpace(accountId, spaceId);
        this.deps.closedGroups.forgetSpace(accountId, spaceId);
        this.deps.fileDrafts.forgetSpace(accountId, spaceId);
      }
    });
    const selected = navigation.subscribe((next, before) => {
      if (next.current !== before.current || next.key !== before.key) clear();
    });
    return () => {
      protectedChange();
      selected();
      clear();
    };
  }

  scope(status: SpacesStatus | undefined, spaceId: string | null): TeamChatContextValue | null {
    const { gate, navigation } = this.deps;
    const access = gate.status(spaceId);
    if (status?.state !== "ready" || !spaceId || !access.allowed || access.space?.kind !== "organization" || access.identity !== JSON.stringify([status.apiOrigin, status.userId])) {
      this.#leases.enter(null);
      this.#scope = null;
      return null;
    }
    this.#accountId = status.userId;
    const selection = navigation.getState().key;
    this.#leases.enter({ accountId: JSON.stringify([status.apiOrigin, status.userId, access.generation, selection]), spaceId });
    const generation = this.#leases.capture();
    if (this.#scope?.generation === generation && this.#scope.reach === status.reach) return this.#scope;
    const authority = gate.capture(spaceId, status.userId);
    this.#scope = {
      accountId: status.userId,
      spaceId,
      generation,
      reach: status.reach,
      current: () => this.#leases.accepts(generation) && authority.current() && navigation.getState().key === selection && navigation.getState().current === spaceId,
    };
    return this.#scope;
  }
}

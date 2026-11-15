import { hostedRunId } from "@openorc/protocol";
import type { Query, QueryClient } from "@tanstack/react-query";
import { gateIdentity, type OrganizationAccessStore } from "./organization-access-store";
import type { SpaceInventory } from "./space-view";

/** What a frozen admin still reads of an organization. Seats and billing hold their own state, bound to the same gate. */
const RECOVERY = new Set(["organization.people", "organization.invitations"]);

interface Dependencies {
  gate: OrganizationAccessStore;
  queries: QueryClient;
  runs: { forget(runIds: readonly string[]): void };
  navigation: { getState(): { current: string | null; inventory: SpaceInventory[]; close(spaceIds: readonly string[]): void } };
  /** The palette and the dialogs that stand over the work area. */
  overlays: { close(): void };
  /** Where unsent drafts are kept, by key. */
  storage: { keys(): string[]; removeItem(key: string): void };
}

/**
 * The moment an organization closes to this person (frozen, removed, or another account), nothing of it stays in this
 * window: its cached reads are cancelled and removed, its cloud threads' bodies forgotten, its inventory emptied, all
 * before the next paint. Personal, threads on this Mac and private drafts are never touched. What was cached while
 * closed is dropped again when access returns, so an organization is always read fresh.
 */
export function protectOrganizationContent({ gate, queries, runs, navigation, overlays, storage }: Dependencies): () => void {
  return gate.subscribeProtected((change) => {
    const inventory = navigation.getState().inventory;
    const closed = change.spaceIds.filter((id) => !gate.status(id).allowed);
    const reopened = inventory.filter((space) => space.closed && change.spaceIds.includes(space.id) && !closed.includes(space.id)).map((space) => space.id);
    const affected = inventory.filter((space) => !space.personal && (closed.includes(space.id) || reopened.includes(space.id)));
    if (!closed.length && !reopened.length) return;
    const threads = affected.flatMap(cloudThreads);
    const runIds = threads.map(hostedRunId);
    const ids = new Set([...closed, ...reopened, ...threads, ...runIds, ...affected.flatMap(cloudProjects)]);
    const kept = new Set(closed.filter((id) => admin(gate, id)));
    const predicate = (query: Query) => names(query.queryKey[1], ids) && !(RECOVERY.has(String(query.queryKey[0])) && kept.has(spaceOf(query.queryKey[1])));
    void queries.cancelQueries({ predicate });
    queries.removeQueries({ predicate });
    runs.forget(runIds);
    // A freeze keeps what the person had written; a membership or an account that is gone takes its drafts with it.
    const departed = new Set(change.reason === "account" ? change.spaceIds : change.removed);
    forgetDrafts(
      storage,
      affected.filter((space) => departed.has(space.id)),
    );
    const standing = navigation.getState().current;
    navigation.getState().close(closed);
    if (standing && closed.includes(standing)) overlays.close();
  });
}

const cloudThreads = (space: SpaceInventory): string[] => [...space.threads.filter((row) => row.owner?.brain === "hosted").map((row) => row.id), ...(space.unavailable ?? []).map((row) => row.id)];
const cloudProjects = (space: SpaceInventory): string[] =>
  space.projects.flatMap((project) => [...(project.localProjectId ? [] : [project.key]), ...(project.hostedProjectId ? [project.hostedProjectId] : [])]);

function forgetDrafts(storage: Dependencies["storage"], spaces: SpaceInventory[]): void {
  const prefixes = spaces.flatMap((space) => [
    ...cloudThreads(space).map((id) => `openorc.draft.conversation.${id}`),
    ...space.projects.filter((project) => !project.localProjectId).map((project) => `openorc.draft.newthread.${project.key}.`),
  ]);
  if (!prefixes.length) return;
  for (const key of storage.keys()) if (prefixes.some((prefix) => key === prefix || key.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`))) storage.removeItem(key);
}

/** A frozen admin: still a member, still an admin, closed only by Pro. */
function admin(gate: OrganizationAccessStore, spaceId: string): boolean {
  const state = gate.status(spaceId);
  return state.blocked === "frozen" && state.space?.kind === "organization" && state.space.role === "admin";
}

const spaceOf = (params: unknown): string => (params && typeof params === "object" && "spaceId" in params && typeof params.spaceId === "string" ? params.spaceId : "");

function names(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => names(item, ids));
  return Boolean(value && typeof value === "object" && Object.values(value).some((item) => names(item, ids)));
}

/**
 * The gate as a read of the spaces begins. `frozen` is known only once the gate has heard this account; until then
 * everything is read as before. A read that crossed a change of authority is made again, never shown: `held` says
 * "again" for that, and "ended" when the gate has moved on to another account.
 */
export function organizationLease(gate: OrganizationAccessStore, status: { apiOrigin: string; userId: string }) {
  const identity = gateIdentity(status);
  const began = gate.getSnapshot();
  const known = began.ready && began.identity === identity;
  return {
    frozen: known && began.access?.state === "frozen",
    held(): "current" | "again" | "ended" {
      const now = gate.getSnapshot();
      if (now.ready && now.identity !== identity) return "ended";
      if (known) return now.generation === began.generation ? "current" : "again";
      return now.ready && now.access?.state === "frozen" ? "again" : "current";
    },
  };
}

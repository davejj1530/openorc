import type { Run } from "@openorc/protocol";
import type { ClientPush, CoreConnection, Notice } from "./connection.js";
import { useConversationSettingsWith, type SavedThreadSettings } from "./conversation-settings.js";
import { useSubmitWith } from "./conversation-submit.js";
import { useConversationTranscriptWith } from "./conversation-transcript.js";
import { createPermissionDefault } from "./permission-default.js";
import { createQueries } from "./query.js";
import { createRunStore } from "./run-store.js";

export interface ClientStateOptions {
  /** Runs a callback before the next paint, which is as often as a view can use an update. */
  scheduleFrame(callback: () => void): void;
  /** How long pushed invalidations gather before one refetch pass; every refetch costs a round trip to the core. */
  invalidationBatchMs: number;
  /** A fresh unique id, for request keys that let the core drop a message sent twice. */
  randomId(): string;
  /** Choosing a permission also makes it the default for new work. Off where this client may not change app settings. */
  savesDefaultPermission: boolean;
}

/**
 * Everything a client keeps about one core: the query cache, the runs it shows, and the notices it hears. Pushes
 * from the connection are wired here once, so no caller repeats it.
 */
export function createClientState(connection: CoreConnection, options: ClientStateOptions) {
  const queries = createQueries(connection, options.invalidationBatchMs);
  const store = createRunStore(connection, options.scheduleFrame);
  const permissions = createPermissionDefault(connection, queries, options.savesDefaultPermission);
  const notices = new Set<(notice: Notice) => void>();
  const handlers: { [T in ClientPush["type"]]: (push: Extract<ClientPush, { type: T }>) => void } = {
    frame: ({ frame }) => store.runs.applyFrame(frame),
    invalidate: ({ keys }) => queries.invalidateTags(keys),
    notify: ({ notice }) => notices.forEach((listener) => listener(notice)),
    session: ({ resumed }) => {
      // A core that (re)started probes the machine afresh; what the client remembered about CLIs and models is stale.
      if (!resumed) return queries.invalidateTags(["system", "models", "agent-updates"]);
      // Anything could have changed while no pushes arrived.
      void queries.queryClient.invalidateQueries();
      void store.runs.resync();
    },
    gap: ({ runIds }) => void store.runs.resync(runIds),
  };
  connection.onPush((push) => (handlers[push.type] as (push: ClientPush) => void)(push));
  return {
    ...queries,
    ...store,
    ...permissions,
    useSubmit: () => useSubmitWith(queries.useRpcMutation, options.randomId),
    useConversationTranscript: (input: { runs: Run[]; threadId: string | null }) => useConversationTranscriptWith(queries, store, input),
    useConversationSettings: (input: { thread: SavedThreadSettings | null; activeRun: Run | undefined }) => useConversationSettingsWith(queries, permissions, input),
    onNotify(listener: (notice: Notice) => void): () => void {
      notices.add(listener);
      return () => notices.delete(listener);
    },
  };
}

export type ClientState = ReturnType<typeof createClientState>;

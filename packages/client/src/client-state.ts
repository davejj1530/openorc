import type { ClientPush, CoreConnection, Notice } from "./connection.js";
import { useSubmitWith } from "./conversation-submit.js";
import { createQueries } from "./query.js";
import { createRunStore } from "./run-store.js";

export interface ClientStateOptions {
  /** Runs a callback before the next paint, which is as often as a view can use an update. */
  scheduleFrame(callback: () => void): void;
  /** How long pushed invalidations gather before one refetch pass; every refetch costs a round trip to the core. */
  invalidationBatchMs: number;
  /** A fresh unique id, for request keys that let the core drop a message sent twice. */
  randomId(): string;
}

/**
 * Everything a client keeps about one core: the query cache, the runs it shows, and the notices it hears. Pushes
 * from the connection are wired here once, so no caller repeats it.
 */
export function createClientState(connection: CoreConnection, options: ClientStateOptions) {
  const queries = createQueries(connection, options.invalidationBatchMs);
  const store = createRunStore(connection, options.scheduleFrame);
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
    useSubmit: () => useSubmitWith(queries.useRpcMutation, options.randomId),
    onNotify(listener: (notice: Notice) => void): () => void {
      notices.add(listener);
      return () => notices.delete(listener);
    },
  };
}

export type ClientState = ReturnType<typeof createClientState>;

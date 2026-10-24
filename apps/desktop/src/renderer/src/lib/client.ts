import { createClientState } from "@openorc/client";
import { core } from "./rpc";

/** This window's client state, over its port to the core. */
export const client = createClientState(core, {
  // Tests run under Node, which has no animation frames; the store's own timer publishes there.
  scheduleFrame: (callback) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  },
  invalidationBatchMs: 50,
  randomId: () => crypto.randomUUID(),
  savesDefaultPermission: true,
});

export const {
  queryClient,
  useRpc,
  useRpcs,
  useRpcMutation,
  invalidateTags,
  runs,
  useRun,
  useRuns,
  useRunMap,
  usePendingApprovals,
  useSubmit,
  useConversationTranscript,
  useConversationSettings,
  usePermissionSelection,
} = client;

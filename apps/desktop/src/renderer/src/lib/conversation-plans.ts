import { useRpc } from "./client";

/** Validate provenance at the display boundary too: a dev renderer can be newer
 * than its core process, and persisted response copies are not plan documents. */
export function useConversationPlans(threadId: string, enabled = true) {
  const query = useRpc("threads.plans", { id: threadId }, { enabled });
  const plans = (query.data ?? []).filter((plan) => plan.source === "native");
  return { query, plans, isSuccess: query.isSuccess };
}

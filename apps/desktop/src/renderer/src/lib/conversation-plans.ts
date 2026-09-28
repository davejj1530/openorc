import { useRpc } from "./query";

/** Validate provenance at the display boundary too: a dev renderer can be newer
 * than its core process, and persisted response copies are not plan documents. */
export function useConversationPlans(threadId: string, team: boolean, enabled = true) {
  const query = useRpc("threads.plans", { id: threadId }, { enabled });
  const runtime = useRpc("orchestration.runtime", { threadId }, { enabled: enabled && team });
  const leadRuns = new Set(runtime.data?.executions.flatMap((execution) => execution.actors.filter((actor) => actor.id === "lead").flatMap((actor) => actor.runIds)) ?? []);
  const plans = (query.data ?? []).filter((plan) => plan.source === "native" && (!team || leadRuns.has(plan.runId)));
  return { query, runtime, plans, isSuccess: query.isSuccess && (!team || runtime.isSuccess) };
}

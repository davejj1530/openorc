import { CancelledError, type QueryClient } from "@tanstack/react-query";
import { teamRuntimeQueryKey } from "./team-control-scope";

/** Only a network result after the save can confirm the current writer policy. */
export function refreshTeamPermissionReport(client: QueryClient, threadId: string, taskId?: string): Promise<void> {
  const filter = { queryKey: teamRuntimeQueryKey(threadId, taskId), exact: true };
  const cache = client.getQueryCache();
  const query = cache.find(filter);
  if (!query || query.isDisabled()) return Promise.reject(new Error("Reload team activity to check current permissions."));
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type === "removed") finish(new Error("Team activity was removed before permissions could be checked."));
      if (event.type !== "updated") return;
      if (event.action.type === "success" && !event.action.manual) finish();
      if (event.action.type === "error" && !(event.action.error instanceof CancelledError)) finish(event.action.error);
    });
    // Discard a pre-save fetch once. Approval/lifecycle invalidations may replace
    // this fetch again: its rejected promise is not a failed policy read. Wait
    // for the successor's real network result, never a matching cached value.
    void client.refetchQueries(filter, { cancelRefetch: true, throwOnError: true }).catch((error) => {
      if (!(error instanceof CancelledError)) finish(error);
    });
  });
}

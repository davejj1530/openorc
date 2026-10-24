import type { RpcMethod } from "@openorc/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { ConnectionManager } from "../connection/manager";

/** What Home reads, and pull to refresh reads again. */
const HOME_READS: readonly RpcMethod[] = ["projects.list", "threads.list", "inbox.list", "threads.get"];

/**
 * Pull to refresh on Home: connected, the lists again; otherwise the connection, now rather than at the next backoff
 * step. Resolves once the reads or the attempt have settled, which ends the spinner.
 */
export async function refreshHome(link: Pick<ConnectionManager, "getState" | "retry">, queryClient: QueryClient): Promise<void> {
  if (link.getState().kind !== "connected") return link.retry();
  await Promise.all(HOME_READS.map((method) => queryClient.invalidateQueries({ queryKey: [method] })));
}

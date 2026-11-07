import type { RpcMethod } from "@openorc/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { ConnectionManager } from "../connection/manager";

/** What Home reads, and pull to refresh reads again. */
const HOME_READS: readonly RpcMethod[] = ["projects.list", "threads.list", "inbox.list", "threads.get"];

const readAgain = (queryClient: QueryClient) => Promise.all(HOME_READS.map((method) => queryClient.invalidateQueries({ queryKey: [method] })));

/**
 * Pull to refresh on Home: connected, the lists again; otherwise the connection, now rather than at the next backoff
 * step. The partner host's lists too while it is connected; Home never dials or wakes it. Resolves once the reads or the
 * attempt have settled, which ends the spinner.
 */
export async function refreshHome(
  link: Pick<ConnectionManager, "getState" | "retry">,
  queryClient: QueryClient,
  partner: { link: Pick<ConnectionManager, "getState">; queryClient: QueryClient } | null = null,
): Promise<void> {
  const shown = link.getState().kind === "connected" ? readAgain(queryClient) : link.retry();
  await Promise.all([shown, partner?.link.getState().kind === "connected" ? readAgain(partner.queryClient) : null]);
}

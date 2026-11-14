import { hostedControlReason, type HostedControl } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../lib/client";

/** Query only for a hosted thread. The normal thread/access invalidations decide when a cached answer is reread. */
export function useHostedCapabilities(thread: ThreadSummary | null | undefined) {
  const hosted = thread?.owner?.brain === "hosted";
  const query = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: hosted, staleTime: 60_000 });
  return { hosted, reason: (control: HostedControl) => hostedControlReason(thread, control, query.data, query.error?.message) };
}

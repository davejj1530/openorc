import { hostedControlReason, type HostedControl } from "@openorc/client";
import { HOSTED_REASONS, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../lib/client";

/** Query only for a hosted thread. The normal thread/access invalidations decide when a cached answer is reread. */
export function useHostedCapabilities(thread: ThreadSummary | null | undefined) {
  const hosted = thread?.owner?.brain === "hosted";
  const query = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: hosted, staleTime: 60_000 });
  return { hosted, reason: (control: HostedControl) => hostedControlReason(thread, control, query.data, query.error?.message) };
}

/**
 * Whether a cloud thread's saved changes may be read: undefined while the server is asked, its reason once it says they
 * are off, and null otherwise. A capability read that fails leaves the change reads to say what is wrong.
 */
export function useHostedChangesReason(threadId: string, enabled = true): string | null | undefined {
  const query = useRpc("hosted.capabilities", { threadId }, { enabled: enabled && threadId !== "", staleTime: 60_000 });
  if (query.error) return null;
  if (!query.data) return undefined;
  const feature = query.data.features.changes;
  return feature?.available ? null : (feature?.reason ?? HOSTED_REASONS.changes);
}

/** Whether a cloud thread's turns get the person's own skills from this Mac: only once its server says they do. */
export function useHostedSkills(thread: ThreadSummary | null | undefined): boolean {
  const hosted = thread?.owner?.brain === "hosted";
  const query = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: hosted, staleTime: 60_000 });
  return hosted && query.data?.features.skills?.available === true;
}

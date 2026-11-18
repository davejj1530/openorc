import { hostedControlReason, type HostedControl } from "@openorc/client";
import { placeOf, type HostedCapabilities, type ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../client";

/**
 * Whether a thread's place serves a control, as the desktop reads it: the Mac always, and a cloud thread once its
 * server says the feature is available. Nothing is served for no thread.
 */
export function useServed(thread: ThreadSummary | null, feature: keyof HostedCapabilities["features"]): boolean {
  const cloud = Boolean(thread && placeOf(thread).elsewhere);
  const capabilities = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: cloud, staleTime: 60_000 });
  return Boolean(thread) && (!cloud || capabilities.data?.features[feature]?.available === true);
}

/**
 * Why a thread's control is held, as the desktop's menus say it: a cloud thread's server's own reason, while it is
 * asked "Checking cloud features…"; null where the control is served, as on the Mac.
 */
export function useHeldReason(thread: ThreadSummary | null, control: HostedControl): string | null {
  const cloud = Boolean(thread && placeOf(thread).elsewhere);
  const capabilities = useRpc("hosted.capabilities", { threadId: thread?.id ?? "" }, { enabled: cloud, staleTime: 60_000 });
  return hostedControlReason(thread, control, capabilities.data, capabilities.error?.message);
}

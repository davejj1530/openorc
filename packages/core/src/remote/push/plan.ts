import type { PushRecipient } from "@openorc/db";
import { pushGroups, type NotifyKind } from "@openorc/protocol";

export type AlertGroup = "needs-you" | "outcome";
export type AlertPlan = { kind: "ring"; sound: boolean } | { kind: "quiet" };

/** A thread that rang a phone this recently is quiet on that phone, unless an approval follows an outcome. */
export const QUIET_WINDOW_MS = 60_000;

export const groupOf = (kind: NotifyKind): AlertGroup => (pushGroups[kind] === "needs-you" ? "needs-you" : "outcome");

/** Pure. Null means this phone hears nothing of the notice. */
export function planAlert(
  notice: { kind: NotifyKind | "test"; threadId: string | null },
  recipient: Pick<PushRecipient, "alerts" | "sound">,
  context: { macInUse: boolean; lastRing: { at: number; group: AlertGroup } | null; now: number },
): AlertPlan | null {
  const ring: AlertPlan = { kind: "ring", sound: recipient.sound };
  if (notice.kind === "test") return ring;
  const group = groupOf(notice.kind);
  if (recipient.alerts === "needs-you" && group === "outcome") return null;
  // At the Mac, outcomes are already on screen and needs-you waits in Notification Center for when you walk away.
  if (context.macInUse) return group === "outcome" ? null : { kind: "quiet" };
  const { lastRing } = context;
  if (lastRing && context.now - lastRing.at < QUIET_WINDOW_MS && (group === "outcome" || lastRing.group === "needs-you")) return { kind: "quiet" };
  return ring;
}

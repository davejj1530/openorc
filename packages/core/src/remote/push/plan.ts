import type { PushRecipient } from "@openorc/db";
import { pushGroups, type NotifyKind } from "@openorc/protocol";

export type AlertGroup = "needs-you" | "outcome" | "text";
export type AlertPlan = { kind: "ring"; sound: boolean } | { kind: "quiet" };

/** A thread that rang a phone this recently is quiet on that phone, unless an approval follows an outcome. */
export const QUIET_WINDOW_MS = 60_000;

/** An Orcling's finished turn in its chats is a text to you, as a person's would be; any other is an outcome. */
export function groupOf(kind: NotifyKind, texted = false): AlertGroup {
  if (pushGroups[kind] === "needs-you") return "needs-you";
  return texted && kind === "finished" ? "text" : "outcome";
}

/** Pure. Null means this phone hears nothing of the notice. */
export function planAlert(
  notice: { kind: NotifyKind | "test"; threadId: string | null; texted?: boolean },
  recipient: Pick<PushRecipient, "alerts" | "sound">,
  context: { macInUse: boolean; lastRing: { at: number; group: AlertGroup } | null; now: number },
): AlertPlan | null {
  const ring: AlertPlan = { kind: "ring", sound: recipient.sound };
  if (notice.kind === "test") return ring;
  const group = groupOf(notice.kind, notice.texted);
  if (recipient.alerts === "needs-you" && group === "outcome") return null;
  // At the Mac, outcomes are already on screen and needs-you waits in Notification Center for when you walk away. A
  // text rings the phone wherever you are, as a person's does.
  if (context.macInUse && group !== "text") return group === "outcome" ? null : { kind: "quiet" };
  const { lastRing } = context;
  if (lastRing && context.now - lastRing.at < QUIET_WINDOW_MS && (group !== "needs-you" || lastRing.group === "needs-you")) return { kind: "quiet" };
  return ring;
}

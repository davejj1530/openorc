import type { TeamMailboxMessage } from "@openorc/protocol";
export function roomAuthorKind(sender: string): "user" | "thread" | "member" {
  if (sender === "user") return "user";
  if (sender.startsWith("thread:")) return "thread";
  return "member";
}
export function requestedChatDelivery(previous: Pick<TeamMailboxMessage, "delivery"> | undefined, now: boolean) {
  if (previous) return previous.delivery;
  return now ? "immediate" : undefined;
}
/** A durable delivered message wins over its older live receipt. */
export function chatDeliveryState({
  messageState,
  receiptState,
}: {
  messageState: TeamMailboxMessage["state"];
  receiptState: string | undefined;
}): "delivered" | "accepted" | "unconfirmed" | "sending" | "queued" {
  if (messageState === "delivered") return "delivered";
  if (receiptState === "accepted") return "accepted";
  if (receiptState === "uncertain") return "unconfirmed";
  if (messageState === "claimed") return "sending";
  return "queued";
}
export function settledRoomDelivery(state: "accepted" | "unavailable" | "uncertain"): "confirmed" | "cancelled" | "uncertain" {
  if (state === "accepted") return "confirmed";
  if (state === "unavailable") return "cancelled";
  return "uncertain";
}

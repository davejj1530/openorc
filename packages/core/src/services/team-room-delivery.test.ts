import { describe, expect, it } from "vitest";
import { chatDeliveryState, requestedChatDelivery } from "./team-room-delivery.js";

describe("chat receipt priority", () => {
  it.each([
    ["delivered", "uncertain", "delivered"],
    ["claimed", "accepted", "accepted"],
    ["claimed", "uncertain", "unconfirmed"],
    ["claimed", undefined, "sending"],
    ["pending", undefined, "queued"],
  ] as const)("%s mailbox with %s receipt reports %s", (messageState, receiptState, expected) => {
    expect(chatDeliveryState({ messageState, receiptState })).toBe(expected);
  });
  it("retains an accepted request's missing delivery choice when a retry asks for immediate delivery", () => {
    expect(requestedChatDelivery({}, true)).toBeUndefined();
    expect(requestedChatDelivery(undefined, true)).toBe("immediate");
  });
});

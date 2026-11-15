import { clearLastNotificationResponse, useLastNotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { link } from "../client";
import { keychainKeys, phoneCrypto } from "../connection/native";
import { noticeOpener, openTap, tapOf } from "./taps";

const open = noticeOpener(phoneCrypto, (macId) => keychainKeys.read(macId));

/**
 * A tap, or Allow or Deny, on an alert: the same path whether it woke the app or found it open, taken once so a
 * remount never replays it. The thread opens over Home, whatever was open before.
 */
export function useNoticeTaps(): void {
  const response = useLastNotificationResponse();
  useEffect(() => {
    if (!response) return;
    clearLastNotificationResponse();
    const tap = tapOf(response.actionIdentifier, response.notification.request.content);
    if (!tap) return;
    void openTap(tap, {
      macs: link.getMacs,
      select: (macId) => link.select(macId),
      openThread: (id) => {
        router.dismissTo("/");
        router.push({ pathname: "/thread/[id]", params: { id } });
      },
      open,
      now: Date.now,
    });
  }, [response]);
}

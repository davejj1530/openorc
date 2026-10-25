import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { clearDelivered } from "./foreground";
import { notificationCenter } from "./native";

let onScreen: string | null = null;

/** The thread the phone shows right now, for alerts that arrive while the app is open. */
export const threadOnScreen = (): string | null => onScreen;

/** A thread screen while it has focus: alerts for it stay quiet, and what they said leaves Notification Center. */
export function useThreadOnScreen(macId: string | null, threadId: string): void {
  useFocusEffect(
    useCallback(() => {
      onScreen = threadId;
      if (macId) void clearDelivered(macId, threadId, notificationCenter);
      return () => {
        if (onScreen === threadId) onScreen = null;
      };
    }, [macId, threadId]),
  );
}

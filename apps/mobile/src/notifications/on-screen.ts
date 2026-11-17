import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { clearDelivered } from "./foreground";
import { notificationCenter } from "./native";

let onScreen: string | null = null;
let cloudSender: () => string | null = () => null;

/** Where the phone's own cloud's sender key is read, set once the app composes its cloud alerts. */
export const knowCloudSender = (read: () => string | null): void => void (cloudSender = read);

/** The thread the phone shows right now, for alerts that arrive while the app is open. */
export const threadOnScreen = (): string | null => onScreen;

/** A thread screen while it has focus: alerts for it stay quiet, and what they said leaves Notification Center. */
export function useThreadOnScreen(macId: string | null, threadId: string): void {
  useFocusEffect(
    useCallback(() => {
      onScreen = threadId;
      const senders = [macId, cloudSender()].filter((sender): sender is string => sender !== null);
      if (senders.length) void clearDelivered(senders, threadId, notificationCenter);
      return () => {
        if (onScreen === threadId) onScreen = null;
      };
    }, [macId, threadId]),
  );
}

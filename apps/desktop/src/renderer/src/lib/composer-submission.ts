import { useCallback, useId, useSyncExternalStore } from "react";

interface Submission {
  text: string;
  attachments: string[];
  status: "pending" | "accepted" | "error";
  error?: string;
}

// A send belongs to its draft, not the mounted view. Navigating away must not
// unlock that draft while its original request is still running.
const submissions = new Map<string, Submission>();
const listeners = new Map<string, Set<() => void>>();
const announce = (key: string) => listeners.get(key)?.forEach((listener) => listener());

export function useComposerSubmission(draftKey?: string) {
  const instanceId = useId();
  const key = draftKey ? `draft:${draftKey}` : `instance:${instanceId}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) {
          listeners.delete(key);
          if (submissions.get(key)?.status === "accepted") submissions.delete(key);
        }
      };
    },
    [key],
  );
  const snapshot = useCallback(() => submissions.get(key), [key]);
  const submission = useSyncExternalStore(subscribe, snapshot);

  return {
    submission,
    acknowledge() {
      if (submissions.get(key) !== submission || submission?.status !== "accepted") return;
      submissions.delete(key);
      announce(key);
    },
    submit(text: string, attachments: string[], send: () => Promise<void>) {
      // Synchronous admission also covers two events before React renders.
      if (submissions.get(key)?.status === "pending") return;
      const pending: Submission = { text, attachments, status: "pending" };
      submissions.set(key, pending);
      announce(key);
      void Promise.resolve()
        .then(send)
        .then(
          () => {
            // The caller persists draft cleanup even when no view is mounted.
            if (listeners.has(key)) submissions.set(key, { ...pending, status: "accepted" });
            else submissions.delete(key);
            announce(key);
          },
          (error: unknown) => {
            if (draftKey || listeners.has(key))
              submissions.set(key, {
                ...pending,
                status: "error",
                error: error instanceof Error ? error.message : "Message couldn’t send. Try again.",
              });
            else submissions.delete(key);
            announce(key);
          },
        );
    },
  };
}

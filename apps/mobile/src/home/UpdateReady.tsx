import { useEffect, useState } from "react";
import { AppState, Pressable, Text } from "react-native";
import * as Updates from "expo-updates";

/** How long the app waits before it looks for a new version again, each time it comes back to the front. */
const LOOK_MS = 30 * 60_000;

/**
 * Whether a new version of the app has downloaded and waits for a restart. Besides its look at each launch, the app
 * looks again when it comes back to the front, at most every half hour.
 */
export function useUpdateReady(): boolean {
  const { isUpdatePending } = Updates.useUpdates();
  useEffect(() => {
    if (!Updates.isEnabled) return;
    let last = Date.now();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || Date.now() - last < LOOK_MS) return;
      last = Date.now();
      void Updates.checkForUpdateAsync()
        .then((found) => (found.isAvailable ? Updates.fetchUpdateAsync() : undefined))
        .catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);
  return Updates.isEnabled && isUpdatePending;
}

/** A new version of the app has downloaded: one quiet pill above New thread restarts into it. */
export function UpdateReady() {
  const ready = useUpdateReady();
  const [restarting, setRestarting] = useState(false);
  if (!ready) return null;
  const restart = () => {
    setRestarting(true);
    void Updates.reloadAsync().catch(() => setRestarting(false));
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Restart to update"
      disabled={restarting}
      onPress={restart}
      className="mb-2 min-h-touch flex-row items-center gap-1.5 rounded-full bg-surface px-4 active:bg-surface-3"
    >
      <Text className="text-base text-ink-3">New version ready</Text>
      <Text className="text-base text-ink">Restart</Text>
    </Pressable>
  );
}

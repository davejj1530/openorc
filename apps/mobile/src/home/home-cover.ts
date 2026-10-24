import { useNavigation, type NativeStackNavigationProp } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";

let covering = 0;
const listeners = new Set<() => void>();

function cover(by: 1 | -1): void {
  covering += by;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether an open thread hides Home. A sheet over Home leaves it in view. */
export function useHomeCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covering > 0);
}

/**
 * For a thread screen: it hides Home from when it opens until it starts to leave, so a swipe back shows Home as it
 * starts, and hides it again if the reader turns back.
 */
export function useCoverHome(): void {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  useEffect(() => {
    let covers = false;
    const set = (next: boolean) => {
      if (next === covers) return;
      covers = next;
      cover(next ? 1 : -1);
    };
    set(true);
    const stop = [navigation.addListener("transitionStart", (event) => set(!event.data.closing)), navigation.addListener("gestureCancel", () => set(true))];
    return () => {
      stop.forEach((unsubscribe) => unsubscribe());
      set(false);
    };
  }, [navigation]);
}

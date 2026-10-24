import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";
import { useReducedMotion as useReducedAtLaunch } from "react-native-reanimated";

let reduced: boolean | null = null;
const listeners = new Set<() => void>();

function follow(next: boolean): void {
  if (next === reduced) return;
  reduced = next;
  listeners.forEach((listener) => listener());
}

void AccessibilityInfo.isReduceMotionEnabled().then(follow);
AccessibilityInfo.addEventListener("reduceMotionChanged", follow);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Whether the reader asked iOS to reduce motion, following the setting while the app runs; Reanimated's own reads it
 * once at launch, which stands in until iOS first answers.
 */
export function useReducedMotion(): boolean {
  const atLaunch = useReducedAtLaunch();
  return useSyncExternalStore(subscribe, () => reduced) ?? atLaunch;
}

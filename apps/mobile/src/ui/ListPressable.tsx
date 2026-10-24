import type { ComponentProps } from "react";
import { Pressable } from "react-native";

/**
 * A row's touch target in a list that scrolls. iOS scroll views here do not hold touches back, so a plain pressable
 * shows its pressed fill on whatever row a scroll starts on; this one waits a beat before it shows it. A tap shorter
 * than the wait still presses.
 */
export function ListPressable(props: ComponentProps<typeof Pressable>) {
  return <Pressable unstable_pressDelay={100} {...props} />;
}

import { Pressable } from "react-native";
import { Text } from "./Text";

/** A faint text button, touch height, that never competes with a screen's one ink pill. */
export function LineAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} className="-mx-3 min-h-touch justify-center rounded-full px-3 active:bg-surface-2">
      <Text className="text-ink-3">{label}</Text>
    </Pressable>
  );
}

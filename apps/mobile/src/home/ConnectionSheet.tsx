import { router } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState } from "../client";
import { MacSection } from "../settings/MacSection";
import { Text } from "../ui/Text";

/**
 * Which Mac or cloud brain Home shows and how this phone reaches it, from the header's connection button: the same
 * rows as Settings' first section, to switch hosts, try again or pair another.
 */
export function ConnectionSheet() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  return (
    <View className="bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Connection
      </Text>
      <MacSection state={state} />
    </View>
  );
}

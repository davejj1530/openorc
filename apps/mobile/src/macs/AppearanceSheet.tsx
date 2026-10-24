import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { APPEARANCES, chooseAppearance, useAppearance } from "../appearance";
import { Check } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";

/** System, Light or Dark, as iOS's own Appearance lists them. The sheet stays, so the change shows under it. */
export function AppearanceSheet() {
  const insets = useSafeAreaInsets();
  const current = useAppearance();
  return (
    <View className="gap-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Appearance
      </Text>
      {APPEARANCES.map(({ choice, label }) => (
        <Pressable
          key={choice}
          accessibilityRole="radio"
          accessibilityState={{ checked: choice === current }}
          onPress={() => {
            if (choice === current) return;
            haptic.select();
            chooseAppearance(choice);
          }}
          className="min-h-touch flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
        >
          <Text className="flex-1 text-md">{label}</Text>
          {choice === current ? <Check size={16} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

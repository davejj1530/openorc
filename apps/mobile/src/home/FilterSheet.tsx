import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { chooseFilter, FILTER_CHOICES, filterChoice, useHomeFilter } from "./filter";

/** What Home lists, as the sidebar's filter menu offers it. Closes on a pick, as the Mode sheet does. */
export function FilterSheet() {
  const insets = useSafeAreaInsets();
  const current = filterChoice(useHomeFilter());
  return (
    <View className="gap-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Show
      </Text>
      {FILTER_CHOICES.map(({ choice, label }) => (
        <Pressable
          key={choice}
          accessibilityRole="radio"
          accessibilityState={{ checked: choice === current }}
          onPress={() => {
            if (choice !== current) {
              haptic.select();
              chooseFilter(choice);
            }
            router.back();
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

import { router, useLocalSearchParams } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Cloud, Laptop } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { useSharedSettings, type ThreadPlace } from "./settings-bridge";

const hints = {
  vercel: "A Vercel sandbox of its own; its changes arrive in a worktree on the Mac",
  local: "A sandbox simulated on the Mac; its changes arrive in a worktree there",
} as const;

/** Where a new thread runs: on the Mac, where its threads start, or in a sandbox of its own. */
export function PlaceSheet() {
  const { composerId } = useLocalSearchParams<{ composerId: string }>();
  const insets = useSafeAreaInsets();
  const place = useSharedSettings(composerId)?.place;
  const options: { value: ThreadPlace; label: string; hint: string; Icon: typeof Cloud }[] = [
    { value: "mac", label: "This Mac", hint: "Where the Mac starts its threads", Icon: Laptop },
    { value: "cloud", label: "Cloud", hint: hints[place?.provider ?? "vercel"], Icon: Cloud },
  ];
  return (
    <View className="gap-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Runs on
      </Text>
      {options.map(({ value, label, hint, Icon }) => (
        <Pressable
          key={value}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === place?.chosen }}
          onPress={() => {
            if (!place) return;
            haptic.select();
            place.select(value);
            router.back();
          }}
          className="min-h-touch-row flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
        >
          <Icon size={16} className="text-ink-3" />
          <View className="min-w-0 flex-1">
            <Text className="text-md">{label}</Text>
            <Text className="text-sm text-ink-4">{hint}</Text>
          </View>
          {value === place?.chosen ? <Check size={16} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

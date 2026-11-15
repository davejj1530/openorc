import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { chooseSpace } from "./space-choice";
import { SpaceMark } from "./SpaceMark";
import { spaceName, useSpaces } from "./use-spaces";

/**
 * Which space Home shows, from the bar's title: Personal, then the person's organizations, as the Mac's space menu
 * lists them. Closes on a pick, as the Show sheet does. The choice is this phone's own.
 */
export function SpaceSheet() {
  const insets = useSafeAreaInsets();
  const account = useSpaces();
  const spaces = account.state === "ready" ? account.spaces : [];
  const current = account.state === "ready" ? account.current.id : null;
  return (
    <View className="gap-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Spaces
      </Text>
      {spaces.map((space) => (
        <Pressable
          key={space.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: space.id === current }}
          accessibilityLabel={spaceName(space)}
          onPress={() => {
            if (space.id !== current) {
              haptic.select();
              chooseSpace(space.id);
            }
            router.back();
          }}
          className="min-h-touch-row flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
        >
          <SpaceMark space={space} size={28} />
          <View className="flex-1">
            <Text numberOfLines={1} className="text-md">
              {spaceName(space)}
            </Text>
            {space.kind === "organization" ? (
              <Text numberOfLines={1} className="text-sm text-ink-4">
                {space.memberCount === 1 ? "1 person" : `${space.memberCount} people`}
              </Text>
            ) : null}
          </View>
          {space.id === current ? <Check size={16} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

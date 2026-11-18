import type { Space } from "@openorc/protocol";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useRpc } from "../client";
import { Check } from "../generated/icons";
import { FitSheet } from "../ui/FitSheet";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { chooseSpace } from "./space-choice";
import { SpaceMark } from "./SpaceMark";
import { titleName, useSpaces } from "./use-spaces";

/**
 * Which space Home shows, from the bar's title: the person's own, called OpenOrc as the bar calls it, then their
 * organizations, in the order the Mac's space menu lists them. Closes on a pick, as the Show sheet does. The choice is
 * this phone's own.
 */
export function SpaceSheet() {
  const account = useSpaces();
  const spaces = account.state === "ready" ? account.spaces : [];
  const current = account.state === "ready" ? account.current.id : null;
  const person = useRpc("account.person", {}, { enabled: account.state === "ready" }).data?.name;
  /** Under a space's name, as the Mac's menu has it: whose own it is, and how many people an organization has. */
  const detail = (space: Space) => {
    if (space.kind === "personal") return person ?? null;
    return space.memberCount === 1 ? "1 person" : `${space.memberCount} people`;
  };
  return (
    <FitSheet className="gap-1 px-5 pt-6" onAccessibilityEscape={() => router.back()}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Spaces
      </Text>
      {spaces.map((space) => (
        <Pressable
          key={space.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: space.id === current }}
          accessibilityLabel={titleName(space)}
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
              {titleName(space)}
            </Text>
            {detail(space) ? (
              <Text numberOfLines={1} className="text-sm text-ink-4">
                {detail(space)}
              </Text>
            ) : null}
          </View>
          {space.id === current ? <Check size={16} /> : null}
        </Pressable>
      ))}
    </FitSheet>
  );
}

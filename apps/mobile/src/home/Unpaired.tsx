import { Link } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showDemo } from "../client";
import type { LinkState, LostMac } from "../connection/manager";
import { haptic } from "../ui/haptics";
import { LineAction } from "../ui/LineAction";
import { Text } from "../ui/Text";
import { HomeBar } from "./header/HomeBar";
import { LostLine } from "./header/MacLine";

/**
 * No Mac yet: the bar, the line saying why the last Mac went when the person did not forget it, and one quiet way in,
 * with the demo a faint line under it for anyone who skipped it.
 */
export function Unpaired({ state }: { state: Extract<LinkState, { kind: "unpaired" }> }) {
  const insets = useSafeAreaInsets();
  const told = useRef<LostMac | null>(null);
  const { lost } = state;
  useEffect(() => {
    if (!lost || told.current === lost) return;
    told.current = lost;
    haptic.warn();
  }, [lost]);
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <HomeBar state={state} />
      {lost ? <LostLine lost={lost} /> : null}
      <View className="flex-1 items-center justify-center gap-2 px-10">
        <Text accessibilityRole="header" className="text-xl">
          Pair with your Mac
        </Text>
        <Text className="text-center text-ink-4">Scan the code OpenOrc shows on your Mac.</Text>
        <Link href="/pair" asChild>
          <Pressable accessibilityRole="button" className="mt-4 min-h-touch justify-center rounded-full bg-accent px-5 active:opacity-80">
            <Text className="text-md text-accent-fg">Scan code</Text>
          </Pressable>
        </Link>
        <View className="mt-1">
          <LineAction label="Try the demo" onPress={showDemo} />
        </View>
      </View>
    </View>
  );
}

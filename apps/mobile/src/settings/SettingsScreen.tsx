import { router, Stack } from "expo-router";
import { View } from "react-native";
import Animated, { useAnimatedRef, useScrollOffset } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState } from "../client";
import { swipes } from "../ui/swipe";
import { ForgetMac, MacSection } from "./MacSection";
import { PhoneSection } from "./PhoneSection";
import { SettingsHeader } from "./SettingsHeader";
import { UsageSection } from "./UsageSection";

const close = () => router.back();
const body = "gap-7 px-5 pt-2";

/**
 * The phone's one Settings, split by who owns each setting: the Mac it shows and how it is reached, that Mac's plan
 * limits, then what this phone keeps for itself, and forgetting the Mac last. Everything else stays in the Mac's own
 * Settings. With no Mac there is little to show, so the sheet fits it rather than filling the screen.
 */
export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  const paired = state.kind !== "unpaired";
  const scroller = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollOffset(scroller);
  const sections = (
    <>
      <MacSection state={state} />
      {paired ? <UsageSection /> : null}
      <PhoneSection />
      {paired ? <ForgetMac mac={state.mac} /> : null}
    </>
  );
  const bottom = { paddingBottom: insets.bottom + 24 };
  // The sheet's scroll view is its root, as iOS sheets expect; the header sticks to its top.
  return (
    <>
      <Stack.Screen options={{ sheetAllowedDetents: paired ? [1] : "fitToContents" }} />
      {paired ? (
        <Animated.ScrollView ref={scroller} className="flex-1 bg-bg" stickyHeaderIndices={[0]} contentContainerStyle={bottom} onAccessibilityEscape={close} onTouchStart={swipes.touched}>
          <SettingsHeader scrollY={scrollY} onClose={close} />
          <View className={body}>{sections}</View>
        </Animated.ScrollView>
      ) : (
        <View className="bg-bg" onAccessibilityEscape={close}>
          <SettingsHeader scrollY={scrollY} onClose={close} />
          <View className={body}>{sections}</View>
          {/* A fitted sheet floats clear of the home indicator on iOS 26: only what of it the sheet covers is kept. */}
          <SafeAreaView edges={["bottom"]} style={{ paddingTop: 24 }} />
        </View>
      )}
    </>
  );
}

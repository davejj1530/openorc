import { router } from "expo-router";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, useLinkState, useSavedMacs } from "../client";
import { linkWords, type LinkWords } from "../connection/link-words";
import type { SavedMac } from "../connection/saved-macs";
import { Laptop, Plus, Sun } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { swipeAccessibility, swipes, type SwipeAction } from "../ui/swipe";
import { SwipeRow } from "../ui/SwipeRow";
import { Text } from "../ui/Text";
import { LinkDot } from "./LinkDot";

function confirmForget(mac: SavedMac): void {
  Alert.alert(`Forget ${mac.name}?`, "To connect again, scan a new code on your Mac.", [
    { text: "Cancel", style: "cancel" },
    { text: "Forget", style: "destructive", onPress: () => void link.forget(mac.id) },
  ]);
}

/**
 * Shows a saved Mac on Home and goes back there, where it connects. Another Mac also takes the phone Home on its own
 * (the layout's leaveOnMacChange); a second dismissTo where Home already shows does nothing, where back would find
 * nothing to close.
 */
function show(mac: SavedMac): void {
  haptic.select();
  link.select(mac.id);
  router.dismissTo("/");
}

/** `words` describe the connection when this is the Mac Home shows. Forget is a swipe away, and a VoiceOver action. */
function MacRow({ mac, words }: { mac: SavedMac; words: LinkWords | null }) {
  const forget: SwipeAction = { label: "Forget", tone: "bad", run: () => confirmForget(mac) };
  return (
    <SwipeRow id={mac.id} trailing={forget}>
      <ListPressable
        accessibilityRole="button"
        accessibilityState={{ selected: words !== null }}
        accessibilityLabel={[mac.name, words?.status].filter(Boolean).join(", ")}
        {...swipeAccessibility([forget])}
        onPress={() => show(mac)}
        className="min-h-touch-row flex-row items-center gap-3 bg-bg px-5 active:bg-surface-2"
      >
        <View className="size-4 items-center justify-center">{words ? <LinkDot tone={words.tone} /> : <Laptop size={16} className="text-ink-4" />}</View>
        <View className="flex-1 py-1.5">
          <Text numberOfLines={1} className="text-md">
            {mac.name}
          </Text>
          {words ? (
            <Text numberOfLines={1} className="text-sm text-ink-4">
              {words.status}
            </Text>
          ) : null}
        </View>
      </ListPressable>
    </SwipeRow>
  );
}

/** A plain row at the foot of the sheet. */
function FootRow({ icon: Icon, label, onPress }: { icon: typeof Plus; label: string; onPress: () => void }) {
  return (
    <ListPressable accessibilityRole="button" onPress={onPress} className="min-h-touch-row flex-row items-center gap-3 px-5 active:bg-surface-2">
      <View className="size-4 items-center justify-center">
        <Icon size={16} className="text-ink-4" />
      </View>
      <Text className="text-md text-ink-3">{label}</Text>
    </ListPressable>
  );
}

/** The Macs this phone paired with: which one Home shows and how it is connected, another to switch to, and the phone's Appearance. */
export function MacsSheet() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  const macs = useSavedMacs();
  const shownId = state.kind === "unpaired" ? null : state.mac.id;
  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="pt-6"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      onAccessibilityEscape={() => router.back()}
      onTouchStart={swipes.touched}
    >
      <Text accessibilityRole="header" className="mb-2 px-5 text-xl">
        Macs
      </Text>
      {macs.map((mac) => (
        <MacRow key={mac.id} mac={mac} words={mac.id === shownId ? linkWords(state) : null} />
      ))}
      <FootRow icon={Plus} label="Pair a Mac" onPress={() => router.push("/pair")} />
      <FootRow icon={Sun} label="Appearance" onPress={() => router.push("/appearance")} />
    </ScrollView>
  );
}

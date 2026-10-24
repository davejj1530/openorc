import { router } from "expo-router";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, useLinkState } from "../client";
import { linkWords, type LinkWords } from "../connection/link-words";
import type { SavedMac } from "../connection/saved-macs";
import { Laptop, Plus } from "../generated/icons";
import { Text } from "../ui/Text";
import { LinkDot } from "./LinkDot";

function confirmForget(mac: SavedMac): void {
  Alert.alert(`Forget ${mac.name}?`, "To connect again, scan a new code on your Mac.", [
    { text: "Cancel", style: "cancel" },
    { text: "Forget", style: "destructive", onPress: () => void link.forget(mac.id) },
  ]);
}

/** `words` describe the connection when this is the Mac Home shows. */
function MacRow({ mac, words }: { mac: SavedMac; words: LinkWords | null }) {
  return (
    <View className="h-touch-row flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: words !== null }}
        accessibilityLabel={[mac.name, words?.status].filter(Boolean).join(", ")}
        onPress={() => link.select(mac.id)}
        className="h-full flex-1 flex-row items-center gap-3 rounded-md active:bg-surface-2"
      >
        <View className="size-4 items-center justify-center">{words ? <LinkDot tone={words.tone} /> : <Laptop size={16} className="text-ink-4" />}</View>
        <View className="flex-1">
          <Text numberOfLines={1} className="text-md">
            {mac.name}
          </Text>
          {words ? (
            <Text numberOfLines={1} className="text-sm text-ink-4">
              {words.status}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Forget ${mac.name}`} onPress={() => confirmForget(mac)} className="h-touch justify-center rounded-full px-3 active:bg-surface-2">
        <Text className="text-ink-4">Forget</Text>
      </Pressable>
    </View>
  );
}

/** The Macs this phone paired with: which one Home shows and how it is connected, another to switch to, Forget. */
export function MacsSheet() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  const shownId = state.kind === "unpaired" ? null : state.mac.id;
  return (
    <View className="flex-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom }}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Macs
      </Text>
      {link.macs().map((mac) => (
        <MacRow key={mac.id} mac={mac} words={mac.id === shownId ? linkWords(state) : null} />
      ))}
      <Pressable accessibilityRole="button" onPress={() => router.push("/pair")} className="h-touch-row flex-row items-center gap-3 rounded-md active:bg-surface-2">
        <View className="size-4 items-center justify-center">
          <Plus size={16} className="text-ink-4" />
        </View>
        <Text className="text-md text-ink-3">Pair a Mac</Text>
      </Pressable>
    </View>
  );
}

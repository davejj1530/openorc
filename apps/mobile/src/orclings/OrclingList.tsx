import type { OrclingChatSummary } from "@openorc/protocol";
import { useIsFocused } from "expo-router";
import { memo } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import { chatStatus, lastLine, lastWhen, needsYou } from "./orcling-chats";
import { useOpenChat } from "./OrclingFaces";
import { OrclingMotion, seedOf, type OrclingMood } from "./OrclingMotion";

/** What a face does in the list: it hops while its Orcling works, nudges while it wants the person, and breathes otherwise. */
export function moodOf(chat: OrclingChatSummary): OrclingMood {
  if (chatStatus(chat)?.kind === "running") return "working";
  return needsYou(chat) ? "asking" : "rest";
}

/** While the Orcling works, a quiet tag after its name says so. */
function WorkingTag() {
  return (
    <View className="rounded-md bg-surface-2 px-2 py-0.5">
      <Text className="text-detail text-ink-4">Working</Text>
    </View>
  );
}

/**
 * One conversation, as a messaging app lists it, with hierarchy from ink and size alone: the moving face, the name in
 * ink at the list's largest size, the newest message on one muted line, and its time faint at the end of the name's
 * line. A conversation that wants the person shows its message darker, with a dot at the line's end.
 */
const OrclingRow = memo(function OrclingRow({ chat, paused, open }: { chat: OrclingChatSummary; paused: boolean; open: (chat: OrclingChatSummary) => void }) {
  const status = chatStatus(chat);
  const unread = needsYou(chat);
  const line = lastLine(chat);
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[chat.name, status?.label, line].filter(Boolean).join(", ")}
      onPress={() => open(chat)}
      // The face's drawing leaves 13% of its box clear, so its body starts at the screen's margin, as titles do elsewhere.
      className="mx-2 flex-row items-center gap-2 rounded-2xl py-3 pl-1 pr-3 active:bg-surface-2"
    >
      <OrclingMotion look={chat.look} size={60} seed={seedOf(chat.id)} mood={moodOf(chat)} paused={paused} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-shrink text-xl">
            {chat.name}
          </Text>
          {status?.kind === "running" ? <WorkingTag /> : null}
          <View className="flex-1" />
          {chat.last ? <Text className="text-detail text-ink-4 tabular-nums">{lastWhen(chat.last.createdAt)}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-lg", unread ? "text-ink-2" : "text-ink-4")}>
            {line}
          </Text>
          {unread ? <View accessibilityElementsHidden className={cn("size-2.5 rounded-full", status?.kind === "failed" ? "bg-bad" : "bg-attention")} /> : null}
        </View>
      </View>
    </ListPressable>
  );
});

/**
 * Every Orcling as a messaging app lists its conversations, each face alive. `shown` is false while another of Home's
 * tabs is in front; the faces hold still then, and while a screen covers Home. Making one stays on the Mac.
 */
export function OrclingList({ chats, top, bottom, shown = true }: { chats: readonly OrclingChatSummary[]; top: number; bottom: number; shown?: boolean }) {
  const insets = useSafeAreaInsets();
  const open = useOpenChat();
  const focused = useIsFocused();
  const paused = !shown || !focused;
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + top, paddingBottom: insets.bottom + bottom }} accessibilityLabel="Orclings">
      {chats.length ? (
        chats.map((chat) => <OrclingRow key={chat.id} chat={chat} paused={paused} open={open} />)
      ) : (
        <View className="items-center gap-1 px-8 pt-24">
          <Text className="text-lg text-ink-2">No Orclings yet</Text>
          <Text className="text-center text-detail text-ink-4">Make one in OpenOrc on your Mac, and it texts you here.</Text>
        </View>
      )}
    </ScrollView>
  );
}

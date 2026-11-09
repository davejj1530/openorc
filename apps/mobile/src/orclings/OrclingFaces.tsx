import type { OrclingChatSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { useContext } from "react";
import { ScrollView, View } from "react-native";
import { HostContext } from "../connection/host-context";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { MARGIN } from "../home/grid";
import { Text } from "../ui/Text";
import { MARK_INSET } from "../ui/Wordmark";
import { OrclingFace } from "./OrclingFace";
import { chatStatus, needsYou } from "./orcling-chats";

/**
 * A face, and its pin, wider than the face for the name under it. The row's lead puts the first face's body (which
 * starts 13% into its box, as every shape's does) on the wordmark cube's edge, so the faces hang from the same line.
 */
const FACE = 56;
const PIN = 72;
const BODY_INSET = 0.13;
const LEAD = MARGIN + MARK_INSET - FACE * BODY_INSET - (PIN - FACE) / 2;
/** The dot's size with its cut-out, and its center on the face: over the body's top right edge, as a badge overhangs, clear of a hat. */
const DOT = 18;
const DOT_AT = { x: 0.86, y: 0.16 };

/** An Orcling's own conversation, opened as a thread is. */
export function useOpenChat(): (chat: OrclingChatSummary) => void {
  const host = useContext(HostContext);
  return (chat) => router.push({ pathname: "/thread/[id]", params: host ? { id: chat.threadId, host } : { id: chat.threadId } });
}

/** A dot on the face while its Orcling wants the person: the attention tone, or the bad one when its turn failed, cut out of the ground. */
function NeedsYouDot({ failed }: { failed: boolean }) {
  return (
    <View
      testID="needs-you"
      accessibilityElementsHidden
      className={cn("absolute rounded-full border-[3px] border-bg", failed ? "bg-bad" : "bg-attention")}
      style={{ width: DOT, height: DOT, left: FACE * DOT_AT.x - DOT / 2, top: FACE * DOT_AT.y - DOT / 2 }}
    />
  );
}

function Pin({ chat, open }: { chat: OrclingChatSummary; open: (chat: OrclingChatSummary) => void }) {
  const wants = needsYou(chat);
  const status = chatStatus(chat);
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[chat.name, status?.label].filter(Boolean).join(", ")}
      onPress={() => open(chat)}
      className="items-center gap-1.5 active:opacity-60"
      style={{ width: PIN }}
    >
      <View style={{ width: FACE, height: FACE }}>
        <OrclingFace look={chat.look} size={FACE} />
        {wants ? <NeedsYouDot failed={status?.kind === "failed"} /> : null}
      </View>
      <Text numberOfLines={1} className={cn("text-xs", wants ? "text-ink" : "text-ink-3")}>
        {chat.name}
      </Text>
    </ListPressable>
  );
}

/**
 * The Orclings' faces in a row over Threads, as pinned conversations are, the first on the wordmark's edge: a dot on
 * one whose conversation waits on the person or has texts unread, and a tap opens its chat.
 */
export function OrclingFaces({ chats }: { chats: readonly OrclingChatSummary[] }) {
  const open = useOpenChat();
  if (!chats.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Orclings" contentContainerClassName="pb-2 pt-4" contentContainerStyle={{ paddingHorizontal: LEAD }}>
      {chats.map((chat) => (
        <Pin key={chat.id} chat={chat} open={open} />
      ))}
    </ScrollView>
  );
}

import { rowAge, useSidebarNow, type TeamChatLease } from "@openorc/client";
import type { TeamChatPins } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { teamChat } from "../client";
import { ListPressable } from "../ui/ListPressable";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { ActorFace, authorOf } from "./Author";
import { useChatLease } from "./lease";
import { showMessage } from "./reveal";

const close = () => router.back();

/** One pinned message: who wrote it, its words, and who pinned it when; a tap shows it in the conversation. */
function PinRow({ pin, self, now, onOpen }: { pin: TeamChatPins["pins"][number]; self: string; now: number; onOpen: () => void }) {
  const { message } = pin;
  const author = authorOf(message, self);
  const pinned = `Pinned by ${pin.pinnedBy?.id === self ? "you" : (pin.pinnedBy?.name ?? "a former member")} · ${rowAge(Date.parse(pin.pinnedAt), now)}`;
  const words = message.body.trim() || message.files.map((file) => file.name).join(", ");
  return (
    <ListPressable accessibilityRole="button" accessibilityLabel={`${author}: ${words}, ${pinned}`} onPress={onOpen} className="mx-3 flex-row gap-3 rounded-lg px-2 py-3 active:bg-surface-2">
      <ActorFace message={message} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-sm text-ink-3">
          {author}
        </Text>
        <Text numberOfLines={3} className="text-md text-ink">
          {words}
        </Text>
        <Text className="text-sm text-ink-4">{pinned}</Text>
      </View>
    </ListPressable>
  );
}

function Pins({ lease, conversationId }: { lease: TeamChatLease; conversationId: string }) {
  const read = teamChat.usePins(lease, conversationId);
  const now = useSidebarNow();
  if (read.error) return <Text className="px-5 py-10 text-center text-ink-4">{read.error.message}</Text>;
  if (!read.data) return <View className="items-center py-10">{<Spinner />}</View>;
  if (!read.data.pins.length) return <Text className="px-5 py-10 text-center text-ink-4">No pinned messages</Text>;
  return read.data.pins.map((pin) => (
    <PinRow
      key={pin.message.id}
      pin={pin}
      self={lease.accountId}
      now={now}
      onOpen={() => {
        showMessage(conversationId, pin.message);
        close();
      }}
    />
  ));
}

/** A conversation's pinned messages, latest first, as the desktop's pins list shows them; a pin opens its message in place. */
export function ChatPinsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lease = useChatLease();
  const bottom = useSheetBottom(16);
  return (
    <ScrollView className="flex-1 bg-bg" stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={close}>
      <SheetHeader title="Pinned" onClose={close} />
      {lease ? <Pins lease={lease} conversationId={id} /> : null}
    </ScrollView>
  );
}

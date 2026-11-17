import { teamChatList, type TeamChatLease, type TeamChatListRow } from "@openorc/client";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { call, teamChat } from "../client";
import { failureMessage } from "../failure";
import { ListPressable } from "../ui/ListPressable";
import { PersonFace } from "../ui/PersonFace";
import { Text } from "../ui/Text";

/** One conversation: a person's face, or a channel's #, its title, and what is unread in it, an @ where it tags the person. */
function ChatRow({ row, onOpen }: { row: TeamChatListRow; onOpen: (row: TeamChatListRow) => void }) {
  const unread = row.unread > 0;
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[row.title, row.mentioned ? "Mentioned you" : null, unread ? `${row.unread} unread` : null].filter(Boolean).join(", ")}
      onPress={() => onOpen(row)}
      className="mx-3 min-h-touch flex-row items-center gap-3 rounded-lg px-2 py-2.5 active:bg-surface-2"
    >
      {row.kind === "person" ? (
        <PersonFace name={row.person.name} image={row.person.image} size="md" />
      ) : (
        <View className="size-5 items-center justify-center">
          <Text className="text-md text-ink-4">#</Text>
        </View>
      )}
      <Text numberOfLines={1} className="min-w-0 flex-1 text-lg text-ink">
        {row.title}
      </Text>
      {row.mentioned ? <Text className="text-md text-ink">@</Text> : null}
      {unread ? <Text className="text-sm tabular-nums text-attention">{row.unread}</Text> : null}
    </ListPressable>
  );
}

/**
 * The organization's team chat as Home's Chat tab lists it, as the desktop's sidebar does: people first, then groups,
 * then the channels the person joined, each with what is unread. A person not written to yet opens a new conversation.
 */
export function ChatList({ lease, top, bottom }: { lease: TeamChatLease; top: number; bottom: number }) {
  const insets = useSafeAreaInsets();
  const state = teamChat.useChatState(lease);
  const [failure, setFailure] = useState<string | null>(null);
  const rows = teamChatList(state.data, lease.accountId);
  const open = async (row: TeamChatListRow) => {
    setFailure(null);
    try {
      const conversation = row.conversation ?? (await call("teamChat.openDm", { spaceId: lease.spaceId, userIds: [row.id] }));
      router.push({ pathname: "/chat/[id]", params: { id: conversation.id, title: row.title } });
    } catch (error) {
      setFailure(failureMessage(error));
    }
  };
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + top, paddingBottom: insets.bottom + bottom }} accessibilityLabel="Chat">
      {failure ? <Text className="px-5 pb-2 text-sm text-bad">{failure}</Text> : null}
      {state.error ? <Text className="px-5 py-10 text-center text-ink-4">{state.error.message}</Text> : null}
      {rows.map((row) => (
        <ChatRow key={row.id} row={row} onOpen={(each) => void open(each)} />
      ))}
    </ScrollView>
  );
}

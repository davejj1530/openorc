import { teamChatList, type TeamChatLease, type TeamChatListRow } from "@openorc/client";
import { useState } from "react";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { call, teamChat } from "../client";
import { useListOpen } from "../layout";
import { failureMessage } from "../failure";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import { ConversationFace, type ChatPresence } from "./ChatFace";
import { ChatSearchField, ChatSearchHits, SHORTEST_SEARCH } from "./ChatSearch";

/** One conversation: its face, its title, and what is unread in it, an @ where it tags the person. */
function ChatRow({ row, self, presence, onOpen }: { row: TeamChatListRow; self: string; presence: ChatPresence; onOpen: (row: TeamChatListRow) => void }) {
  const unread = row.unread > 0;
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[row.title, row.mentioned ? "Mentioned you" : null, unread ? `${row.unread} unread` : null].filter(Boolean).join(", ")}
      onPress={() => onOpen(row)}
      className="mx-3 min-h-touch flex-row items-center gap-3 rounded-lg px-2 py-2.5 active:bg-surface-2"
    >
      <ConversationFace row={row} self={self} presence={presence} />
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
  const chat = state.data?.state === "ready" ? state.data.chat : null;
  const presence = teamChat.usePresence(lease, Boolean(chat?.features.includes("presence")));
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= SHORTEST_SEARCH;
  const openBeside = useListOpen();
  const open = async (row: TeamChatListRow) => {
    setFailure(null);
    try {
      const conversation = row.conversation ?? (await call("teamChat.openDm", { spaceId: lease.spaceId, userIds: [row.id] }));
      openBeside({ pathname: "/chat/[id]", params: { id: conversation.id } });
    } catch (error) {
      setFailure(failureMessage(error));
    }
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingTop: insets.top + top, paddingBottom: insets.bottom + bottom }}
      accessibilityLabel="Chat"
    >
      {failure ? <Text className="px-5 pb-2 text-sm text-bad">{failure}</Text> : null}
      {state.error ? <Text className="px-5 py-10 text-center text-ink-4">{state.error.message}</Text> : null}
      {chat?.features.includes("search") ? <ChatSearchField query={query} onChange={setQuery} /> : null}
      {searching && chat ? (
        <ChatSearchHits lease={lease} query={query} conversations={chat.conversations} />
      ) : (
        rows.map((row) => <ChatRow key={row.id} row={row} self={lease.accountId} presence={presence} onOpen={(each) => void open(each)} />)
      )}
    </ScrollView>
  );
}

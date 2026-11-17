import { rowAge, teamConversationTitle, useSidebarNow, type TeamChatLease } from "@openorc/client";
import type { TeamChatSearchHit, TeamConversation } from "@openorc/protocol";
import { router } from "expo-router";
import { TextInput, View } from "react-native";
import { teamChat } from "../client";
import { Search } from "../generated/icons";
import { ListPressable } from "../ui/ListPressable";
import { PersonFace } from "../ui/PersonFace";
import { Text } from "../ui/Text";

/** Searching starts at two characters, as on the desktop. */
export const SHORTEST_SEARCH = 2;

/** The field at the top of the Chat list, which searches the organization's messages. */
export function ChatSearchField({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  return (
    <View className="mx-5 mb-3 h-touch flex-row items-center gap-2 rounded-lg bg-surface-2 px-3">
      <Search size={16} className="text-ink-4" />
      <TextInput
        value={query}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        placeholder="Search messages"
        placeholderTextColorClassName="accent-ink-4"
        accessibilityLabel="Search messages"
        className="min-w-0 flex-1 p-0 font-sans text-md text-ink"
      />
    </View>
  );
}

/** Where a hit is: a channel by # and its name, a conversation by its people. */
const placeOf = (conversation: TeamConversation, self: string) => (conversation.kind === "channel" ? `#${teamConversationTitle(conversation, self)}` : teamConversationTitle(conversation, self));

/** One message that matches: its writer's face, its words, where it is and when; it opens in its conversation, at the message. */
function HitRow({ hit, place, age }: { hit: TeamChatSearchHit; place: string; age: string }) {
  const name = hit.person?.name ?? "Former member";
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={`${name}: ${hit.snippet.text}, in ${place}, ${age}`}
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: hit.channelId, message: hit.id, seq: String(hit.seq) } })}
      className="mx-3 flex-row gap-3 rounded-lg px-2 py-2.5 active:bg-surface-2"
    >
      <View className="pt-0.5">
        <PersonFace name={name} image={hit.person?.image ?? null} size="md" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={2} className="text-md text-ink">
          {hit.snippet.text}
        </Text>
        <View className="flex-row gap-2">
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-ink-3">
            {place}
          </Text>
          <Text className="text-sm tabular-nums text-ink-4">{age}</Text>
        </View>
      </View>
    </ListPressable>
  );
}

/** The messages of the organization's chat that match, in the conversations the person may read, newest first as the server gives them. */
export function ChatSearchHits({ lease, query, conversations }: { lease: TeamChatLease; query: string; conversations: readonly TeamConversation[] }) {
  const hits = teamChat.useSearch(lease, query);
  const now = useSidebarNow();
  if (hits.error) return <Text className="px-5 py-10 text-center text-ink-4">{hits.error.message}</Text>;
  if (!hits.data) return null;
  const places = new Map(conversations.map((conversation) => [conversation.id, placeOf(conversation, lease.accountId)]));
  const shown = hits.data.hits.filter((hit) => places.has(hit.channelId));
  if (!shown.length) return <Text className="px-5 py-10 text-center text-ink-4">No messages found</Text>;
  return shown.map((hit) => <HitRow key={hit.id} hit={hit} place={places.get(hit.channelId)!} age={rowAge(Date.parse(hit.createdAt), now)} />);
}

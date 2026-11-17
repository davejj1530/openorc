import { personFirst, type TeamChatLease } from "@openorc/client";
import type { TeamMessage } from "@openorc/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamChat } from "../client";
import { SendButton } from "../composer/SendButton";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { useChatLease } from "./lease";

/** A message the draft began, on its way or kept after it did not go. */
type PendingTeamMessage = NonNullable<ReturnType<typeof teamChat.drafts.begin>>;

/** Who wrote a message: the person, a former member, or an Orcling as "<name> · <owner>'s Orcling". */
function authorOf(message: TeamMessage): string {
  const { actor } = message;
  if (actor.kind === "orcling") return `${actor.name} · ${personFirst(actor.owner)}'s Orcling`;
  return actor.person?.name ?? "Former member";
}

/** Who wrote a message, as a key: the same author writing on needs no name again. */
const authorKey = (message: TeamMessage | undefined): string | null =>
  message ? JSON.stringify([message.actor.kind, message.actor.kind === "orcling" ? message.actor.callId : message.actor.person?.id]) : null;

/** A message: who wrote it over its words where the author changed, the message it answers quoted above them. */
function MessageRow({ message, named }: { message: TeamMessage; named: boolean }) {
  return (
    <View className="gap-1 px-5 py-2">
      {named ? <Text className="pt-1 text-sm text-ink-3">{authorOf(message)}</Text> : null}
      {message.replyTo ? (
        <Text numberOfLines={1} className="border-l-2 border-line pl-2 text-sm text-ink-4">
          {message.replyTo.excerpt}
        </Text>
      ) : null}
      <Text prose selectable className="text-md text-ink">
        {message.body}
      </Text>
    </View>
  );
}

/** A message on its way, or one that did not go, which keeps its id so Retry sends it once. */
function PendingRow({ message, onRetry }: { message: PendingTeamMessage; onRetry: () => void }) {
  return (
    <View className="gap-1 px-5 py-2">
      <Text prose className="text-md text-ink-3">
        {message.body}
      </Text>
      {message.state === "failed" ? (
        <Pressable accessibilityRole="button" onPress={onRetry} className="self-start active:opacity-60">
          <Text className="text-sm text-bad">{message.error ? `${message.error} Retry` : "Didn't send. Retry"}</Text>
        </Pressable>
      ) : (
        <Text className="text-sm text-ink-4">Sending…</Text>
      )}
    </View>
  );
}

/** One conversation of the organization's chat: its messages live, earlier ones a tap away, and a composer that keeps its draft. */
function Conversation({ lease, conversationId }: { lease: TeamChatLease; conversationId: string }) {
  const insets = useSafeAreaInsets();
  const target = useMemo(() => ({ accountId: lease.accountId, spaceId: lease.spaceId, conversationId }), [lease, conversationId]);
  teamChat.useWatch(lease, conversationId);
  const timeline = teamChat.useTimeline(lease, conversationId);
  const draft = teamChat.useDraft(target);
  const list = useRef<ScrollViewInstance>(null);
  const messages = timeline.data?.messages ?? [];
  // The read place moves to the last message shown.
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    if (lastId) void teamChat.seen(lease, target, { id: lastId }).catch(() => undefined);
  }, [lease, target, lastId]);
  const send = (message: PendingTeamMessage) => void teamChat.send(lease, target, message).catch(() => undefined);
  const write = () => {
    const message = teamChat.drafts.begin(target);
    if (message) send(message);
  };
  return (
    <View className="flex-1 bg-bg">
      <ScrollView ref={list} onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })} contentContainerStyle={{ paddingVertical: 12 }}>
        {timeline.data?.older ? (
          <Pressable accessibilityRole="button" onPress={() => void teamChat.earlier(lease, conversationId)} className="items-center py-3 active:opacity-60">
            <Text className="text-sm text-ink-3">Earlier messages</Text>
          </Pressable>
        ) : null}
        {!timeline.data && !timeline.error ? <Spinner /> : null}
        {timeline.error ? <Text className="px-5 py-10 text-center text-ink-4">{timeline.error.message}</Text> : null}
        {messages.map((message, index) => (
          <MessageRow key={message.id} message={message} named={authorKey(message) !== authorKey(messages[index - 1])} />
        ))}
        {draft.pending.map((message) => (
          <PendingRow key={message.id} message={message} onRetry={() => send(message)} />
        ))}
      </ScrollView>
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View className="bg-bg px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
          <View className="flex-row items-end gap-2 rounded-3xl bg-composer-input py-2 pl-4 pr-2">
            <TextInput
              multiline
              value={draft.text}
              onChangeText={(text) => teamChat.drafts.write(target, text)}
              placeholder="Message"
              accessibilityLabel="Message"
              className="min-h-touch flex-1 py-2.5 font-sans text-md leading-5 text-ink"
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: 120 }}
            />
            <SendButton state="send" disabled={!draft.text.trim()} onPress={write} />
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/** A conversation of the shown organization's team chat, pushed over Home from its Chat tab. */
export function ChatScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const lease = useChatLease();
  return (
    <>
      <Stack.Screen options={{ headerTitle: title ?? "" }} />
      {lease ? <Conversation key={`${lease.generation}:${id}`} lease={lease} conversationId={id} /> : <View className="flex-1 bg-bg" />}
    </>
  );
}

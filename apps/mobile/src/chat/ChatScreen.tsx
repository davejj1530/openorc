import { answeredName, answeredOf, personFirst, stretchTime, teamConversationTitle, type TeamChatLease, type TeamChatTarget } from "@openorc/client";
import { TeamChatReaction, type TeamChatAnswered, type TeamConversation, type TeamMessage } from "@openorc/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Pressable, TextInput, View, type ScrollViewInstance } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamChat } from "../client";
import { SendButton } from "../composer/SendButton";
import { OrclingFace } from "../orclings/OrclingFace";
import { PersonFace } from "../ui/PersonFace";
import { Spinner } from "../ui/Spinner";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { chatItems, type ChatItem } from "./chat-items";
import { ChatFiles, ChatFileScopeContext, chatFileScope } from "./ChatFiles";
import { useChatLease } from "./lease";
import { useMessageReveal, type ChatJump } from "./reveal";
import { Reactions } from "./Reactions";

/** A message the draft began, on its way or kept after it did not go. */
type PendingTeamMessage = NonNullable<ReturnType<typeof teamChat.drafts.begin>>;

/** The face beside the last of a run, and the room it keeps at the bubbles' left. */
const FACE = 28;
const BUBBLE_RADIUS = 18;
/** Within a run, the corners that face another bubble close to 6, as on the Mac. */
const runCorners = (item: { first: boolean; last: boolean }) => ({
  borderRadius: BUBBLE_RADIUS,
  borderTopLeftRadius: item.first ? BUBBLE_RADIUS : 6,
  borderBottomLeftRadius: item.last ? BUBBLE_RADIUS : 6,
});

/** Who wrote a message: the person, a former member, or an Orcling as "<name> · <owner>'s Orcling". */
function authorOf(message: TeamMessage, self: string): string {
  const { actor } = message;
  if (actor.kind === "orcling") return `${actor.name} · ${actor.owner.id === self ? "Your" : `${personFirst(actor.owner)}'s`} Orcling`;
  return actor.person?.name ?? "Former member";
}

/** A message of emoji alone, a few, which stands large without a bubble, as Messages draws it. */
const emojiOnly = (body: string) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,24}$/u.test(body.trim()) && /\p{Extended_Pictographic}/u.test(body);

/** A message's words, each link a tap that opens it. */
function Words({ body, className }: { body: string; className: string }) {
  const runs = body.split(/(https?:\/\/[^\s]+)/g);
  return (
    <Text prose selectable className={className}>
      {runs.map((run, index) =>
        index % 2 ? (
          <Text key={index} accessibilityRole="link" onPress={() => openInApp(run)} className="text-accent underline">
            {run}
          </Text>
        ) : (
          run
        ),
      )}
    </Text>
  );
}

/** The message a message answers, as a quiet pill above it. */
function Quote({ answered, self, mine }: { answered: TeamChatAnswered; self: string; mine: boolean }) {
  return (
    <View className={mine ? "max-w-full self-end" : "max-w-full self-start"}>
      <Text numberOfLines={1} className="rounded-full bg-surface-2 px-3 py-1 text-xs text-ink-3">
        {`↰ ${answeredName(answered, self)}  ${answered.excerpt}`}
      </Text>
    </View>
  );
}

/** What a long press on a message offers: a reaction, Reply where the server takes replies, Pin or Unpin for a member. */
interface MessageMoves {
  self: string;
  react: (message: TeamMessage, emoji: TeamChatReaction) => void;
  reply: ((message: TeamMessage) => void) | null;
  pin: ((message: TeamMessage) => void) | null;
}

function offer(message: TeamMessage, moves: MessageMoves) {
  const actions = [
    ...TeamChatReaction.options.map((emoji) => ({ label: emoji, run: () => moves.react(message, emoji) })),
    ...(moves.reply ? [{ label: "Reply", run: () => moves.reply!(message) }] : []),
    ...(moves.pin ? [{ label: message.pinned ? "Unpin" : "Pin", run: () => moves.pin!(message) }] : []),
  ];
  ActionSheetIOS.showActionSheetWithOptions({ options: [...actions.map((action) => action.label), "Cancel"], cancelButtonIndex: actions.length }, (index) => actions[index]?.run());
}

/** A message's words: a few emoji alone stand large, other words sit in the `bubble`; a message of files alone has none. */
function Body({ body, children }: { body: string; children: ReactNode }) {
  if (!body.trim()) return null;
  if (emojiOnly(body)) return <Text className="text-5xl leading-tight">{body.trim()}</Text>;
  return children;
}

/** The reader's own message on the right, in the phone's prompt bubble. */
function Mine({ message, moves }: { message: TeamMessage; moves: MessageMoves }) {
  return (
    <Pressable onLongPress={() => offer(message, moves)} delayLongPress={350} className="items-end gap-1 self-end" style={{ maxWidth: "88%" }}>
      {message.replyTo ? <Quote answered={message.replyTo} self={moves.self} mine /> : null}
      <Body body={message.body}>
        <View className="rounded-2xl bg-bubble px-4 py-3">
          <Words body={message.body} className="text-md text-bubble-ink" />
        </View>
      </Body>
      <ChatFiles files={message.files} mine />
      <Reactions message={message} self={moves.self} mine onReact={(emoji) => moves.react(message, emoji)} />
      {message.pinned ? <Text className="pr-1 text-xs text-ink-4">Pinned</Text> : null}
    </Pressable>
  );
}

/** Who wrote a message, by face: a person's picture or initials, an Orcling's own look. */
function ActorFace({ message }: { message: TeamMessage }) {
  const { actor } = message;
  if (actor.kind === "orcling") return <OrclingFace look={actor.look} size={FACE} />;
  return <PersonFace name={actor.person?.name ?? "?"} image={actor.person?.image ?? null} size="lg" />;
}

/** Another's message on the left: the name over the first of a run, the face beside its last. */
function Theirs({ item, moves }: { item: Extract<ChatItem, { kind: "theirs" }>; moves: MessageMoves }) {
  const { message } = item;
  return (
    <View className="flex-row items-end gap-2" style={{ paddingRight: 48 }}>
      <View style={{ width: FACE }}>{item.last ? <ActorFace message={message} /> : null}</View>
      <Pressable onLongPress={() => offer(message, moves)} delayLongPress={350} className="flex-shrink gap-1">
        {item.first ? <Text className="pl-1 text-sm text-ink-3">{authorOf(message, moves.self)}</Text> : null}
        {message.replyTo ? <Quote answered={message.replyTo} self={moves.self} mine={false} /> : null}
        <Body body={message.body}>
          <View className="self-start bg-surface-2 px-3.5 py-2.5" style={runCorners(item)}>
            <Words body={message.body} className="text-md text-ink" />
          </View>
        </Body>
        <ChatFiles files={message.files} mine={false} />
        <Reactions message={message} self={moves.self} mine={false} onReact={(emoji) => moves.react(message, emoji)} />
        {message.pinned ? <Text className="pl-1 text-xs text-ink-4">Pinned</Text> : null}
      </Pressable>
    </View>
  );
}

/** A message on its way, faint in the reader's bubble, or one that did not go, with Retry under it, as the desktop draws them. */
function Pending({ message, onRetry }: { message: PendingTeamMessage; onRetry: () => void }) {
  const failed = message.state === "failed";
  return (
    <View accessibilityLabel={failed ? undefined : "Sending"} className="items-end gap-1 self-end" style={{ maxWidth: "88%" }}>
      <View className={cn("rounded-2xl bg-bubble px-4 py-3", !failed && "opacity-60")}>
        <Words body={message.body} className="text-md text-bubble-ink" />
      </View>
      {failed ? (
        <Pressable accessibilityRole="button" accessibilityHint={message.error ?? undefined} onPress={onRetry} hitSlop={8} className="flex-row gap-1.5 active:opacity-60">
          <Text className="text-sm text-bad">Message not sent</Text>
          <Text className="text-sm text-ink-2">Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The New messages line at the reader's place, a hairline either side of its words. */
function NewLine({ onLayout }: { onLayout: (y: number) => void }) {
  return (
    <View accessibilityRole="text" onLayout={({ nativeEvent }) => onLayout(nativeEvent.layout.y)} className="flex-row items-center gap-3 px-5">
      <View className="h-px flex-1 bg-line" />
      <Text className="text-xs text-ink-3">New messages</Text>
      <View className="h-px flex-1 bg-line" />
    </View>
  );
}

function Row({ item, moves, onNew }: { item: ChatItem; moves: MessageMoves; onNew: (y: number) => void }) {
  switch (item.kind) {
    case "time":
      return <Text className="text-center text-xs text-ink-4">{stretchTime(item.at)}</Text>;
    case "new":
      return <NewLine onLayout={onNew} />;
    case "mine":
      return <Mine message={item.message} moves={moves} />;
    case "theirs":
      return <Theirs item={item} moves={moves} />;
  }
}

/** The composer under a conversation: what the draft answers, why the last pin failed, and the words, kept per conversation. */
function ChatComposer({ target, title, failure, self, onSend, onFocus }: { target: TeamChatTarget; title: string; failure: string | null; self: string; onSend: () => void; onFocus: () => void }) {
  const insets = useSafeAreaInsets();
  const draft = teamChat.useDraft(target);
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View className="gap-2 bg-bg px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
        {failure ? <Text className="px-2 text-sm text-bad">{failure}</Text> : null}
        {draft.replyTo ? (
          <View className="flex-row items-center gap-2 px-2">
            <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-ink-3">
              {`Replying to ${answeredName(draft.replyTo, self)}: ${draft.replyTo.excerpt}`}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Don't reply" onPress={() => teamChat.drafts.reply(target, null)} hitSlop={8} className="active:opacity-60">
              <Text className="text-sm text-ink-2">Cancel</Text>
            </Pressable>
          </View>
        ) : null}
        <View className="flex-row items-end gap-2 rounded-3xl bg-composer-input py-2 pl-4 pr-2">
          <TextInput
            multiline
            value={draft.text}
            onChangeText={(text) => teamChat.drafts.write(target, text)}
            onFocus={onFocus}
            placeholder={`Message ${title}…`}
            accessibilityLabel="Message"
            className="min-h-touch flex-1 py-2.5 font-sans text-md leading-5 text-ink"
            placeholderTextColorClassName="accent-ink-4"
            style={{ maxHeight: 120 }}
          />
          <SendButton state="send" disabled={!draft.text.trim()} onPress={onSend} />
        </View>
      </View>
    </KeyboardStickyView>
  );
}

/** One conversation of the organization's chat, in the desktop's shape: its messages live, earlier ones a tap away, and a composer that keeps its draft. */
function Conversation({ lease, conversationId, title, newFrom, jump }: { lease: TeamChatLease; conversationId: string; title: string; newFrom: number | null; jump: ChatJump | null }) {
  const insets = useSafeAreaInsets();
  const target = useMemo(() => ({ accountId: lease.accountId, spaceId: lease.spaceId, conversationId }), [lease, conversationId]);
  teamChat.useWatch(lease, conversationId);
  const timeline = teamChat.useTimeline(lease, conversationId);
  const draft = teamChat.useDraft(target);
  const state = teamChat.useChatState(lease).data;
  const chat = state?.state === "ready" ? state.chat : null;
  const joined = chat?.conversations.find((each) => each.id === conversationId)?.joined === true;
  const list = useRef<ScrollViewInstance>(null);
  // Following the end until the reader scrolls up; an unread conversation opens at its New messages line instead, and
  // a search hit at its message.
  const atEnd = useRef(jump === null);
  const opened = useRef(jump !== null);
  const revealId = useMessageReveal(lease, conversationId, timeline.data, jump);
  const revealed = useRef(false);
  const files = useMemo(() => chatFileScope(lease.spaceId, conversationId), [lease, conversationId]);
  const messages = useMemo(() => timeline.data?.messages ?? [], [timeline.data]);
  const sent = new Set(messages.map((message) => message.id));
  const items = useMemo(() => chatItems(messages, lease.accountId, newFrom), [messages, lease.accountId, newFrom]);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    if (lastId) void teamChat.seen(lease, target, { id: lastId }).catch(() => undefined);
  }, [lease, target, lastId]);
  const [failure, setFailure] = useState<string | null>(null);
  const send = (message: PendingTeamMessage) => void teamChat.send(lease, target, message).catch(() => undefined);
  const moves: MessageMoves = {
    self: lease.accountId,
    react: (message, emoji) => void teamChat.react(lease, target, message, emoji).catch((error: Error) => setFailure(error.message)),
    reply: chat?.features.includes("replies") ? (message) => teamChat.drafts.reply(target, answeredOf(message)) : null,
    pin: chat?.features.includes("pins") && joined ? (message) => void teamChat.pin(lease, target, message, !message.pinned).catch((error: Error) => setFailure(error.message)) : null,
  };
  const write = () => {
    const message = teamChat.drafts.begin(target);
    if (!message) return;
    atEnd.current = true;
    send(message);
  };
  const revealAt = (y: number) => {
    if (revealed.current) return;
    revealed.current = true;
    list.current?.scrollTo({ y: Math.max(0, y - 96), animated: false });
  };
  const openAtNew = (y: number) => {
    if (opened.current) return;
    opened.current = true;
    atEnd.current = false;
    list.current?.scrollTo({ y: Math.max(0, y - 48), animated: false });
  };
  return (
    <ChatFileScopeContext.Provider value={files}>
      <View className="flex-1 bg-bg">
        <KeyboardChatScrollView
          ref={list}
          offset={insets.bottom}
          keyboardLiftBehavior="whenAtEnd"
          onScroll={({ nativeEvent }) => {
            atEnd.current = nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >= nativeEvent.contentSize.height - 24;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => atEnd.current && list.current?.scrollToEnd({ animated: false })}
          keyboardDismissMode="interactive"
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12 }}
        >
          {timeline.data?.older ? (
            <Pressable accessibilityRole="button" onPress={() => void teamChat.earlier(lease, conversationId)} className="items-center py-3 active:opacity-60">
              <Text className="text-sm text-ink-3">Earlier messages</Text>
            </Pressable>
          ) : null}
          {!timeline.data && !timeline.error ? <Spinner /> : null}
          {timeline.error ? <Text className="px-5 py-10 text-center text-ink-4">{timeline.error.message}</Text> : null}
          {timeline.data && !messages.length && !draft.pending.length ? <Text className="py-10 text-center text-ink-4">No messages yet</Text> : null}
          {items.map((item) => (
            <View key={item.key} style={{ paddingTop: item.gap }} onLayout={"message" in item && item.message.id === revealId ? ({ nativeEvent }) => revealAt(nativeEvent.layout.y) : undefined}>
              <Row item={item} moves={moves} onNew={openAtNew} />
            </View>
          ))}
          {draft.pending
            .filter((message) => !sent.has(message.id))
            .map((message) => (
              <View key={message.id} style={{ paddingTop: 14 }}>
                <Pending message={message} onRetry={() => send(message)} />
              </View>
            ))}
        </KeyboardChatScrollView>
        <ChatComposer
          target={target}
          title={title}
          failure={failure}
          self={lease.accountId}
          onSend={write}
          onFocus={() => {
            atEnd.current = true;
            setTimeout(() => list.current?.scrollToEnd({ animated: true }), 250);
          }}
        />
      </View>
    </ChatFileScopeContext.Provider>
  );
}

/** A conversation's name as the list names it: a channel by # and its name, a group by its people. */
const conversationTitle = (conversation: TeamConversation, self: string): string =>
  conversation.kind === "channel" ? `#${conversation.name ?? "channel"}` : teamConversationTitle(conversation, self);

/** A conversation of the shown organization's team chat, pushed over Home from its Chat tab, named as the list names it. */
export function ChatScreen() {
  const { id, message, seq } = useLocalSearchParams<{ id: string; message?: string; seq?: string }>();
  const jump = useMemo(() => (message && seq ? { id: message, seq: Number(seq) } : null), [message, seq]);
  const lease = useChatLease();
  const state = teamChat.useChatState(lease).data;
  const conversation = state?.state === "ready" ? state.chat.conversations.find((each) => each.id === id) : undefined;
  const title = conversation ? conversationTitle(conversation, lease?.accountId ?? "") : "";
  // The reader's place as the conversation opened, which the New messages line keeps while it stays open.
  const [newFrom, setNewFrom] = useState<number | null | undefined>(undefined);
  // A conversation just opened, as a first message to a person, is not listed yet: it opens with no line.
  const read = conversation?.read;
  if (newFrom === undefined && state?.state === "ready") setNewFrom(read && read.unread > 0 ? read.seenSeq : null);
  return (
    <>
      <Stack.Screen options={{ headerTitle: title }} />
      {lease && newFrom !== undefined ? (
        <Conversation key={`${lease.generation}:${id}`} lease={lease} conversationId={id} title={title} newFrom={newFrom} jump={jump} />
      ) : (
        <View className="flex-1 bg-bg" />
      )}
    </>
  );
}

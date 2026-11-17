import { answeredName, answeredOf, personFirst, stretchTime, teamConversationTitle, type TeamChatLease, type TeamChatTarget } from "@openorc/client";
import { TeamChatReaction, type TeamChatAnswered, type TeamConversation, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Pressable, View, type ScrollViewInstance } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamChat } from "../client";
import { OrclingFace } from "../orclings/OrclingFace";
import { PersonFace } from "../ui/PersonFace";
import { Spinner } from "../ui/Spinner";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { chatItems, type ChatItem } from "./chat-items";
import { CallLine } from "./CallLine";
import { ChatFiles, ChatFileScopeContext, chatFileScope } from "./ChatFiles";
import { ChatComposer } from "./ChatComposer";
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

/**
 * What the reader can do with a message: a long press offers a reaction, Reply where the server takes replies, and Pin
 * or Unpin for a member; the owner of an Orcling it called tries the call again.
 */
interface MessageMoves {
  lease: TeamChatLease;
  self: string;
  retryCall: (call: TeamOrclingCall) => void;
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

/**
 * What sits under a message's words, each reachable on its own, outside the words' long press: its files, how the
 * Orcling it called is answering, its reactions, and whether it is pinned.
 */
function Under({ message, moves, mine }: { message: TeamMessage; moves: MessageMoves; mine: boolean }) {
  return (
    <>
      <ChatFiles files={message.files} mine={mine} />
      <CallLine lease={moves.lease} call={message.call} mine={mine} onRetry={moves.retryCall} />
      <Reactions message={message} self={moves.self} mine={mine} onReact={(emoji) => moves.react(message, emoji)} />
      {message.pinned ? <Text className={cn("text-xs text-ink-4", mine ? "pr-1" : "pl-1")}>Pinned</Text> : null}
    </>
  );
}

/** The reader's own message on the right, in the phone's prompt bubble. */
function Mine({ message, moves }: { message: TeamMessage; moves: MessageMoves }) {
  return (
    <View className="items-end gap-1 self-end" style={{ maxWidth: "88%" }}>
      <Pressable onLongPress={() => offer(message, moves)} delayLongPress={350} className="items-end gap-1">
        {message.replyTo ? <Quote answered={message.replyTo} self={moves.self} mine /> : null}
        <Body body={message.body}>
          <View className="rounded-2xl bg-bubble px-4 py-3">
            <Words body={message.body} className="text-md text-bubble-ink" />
          </View>
        </Body>
      </Pressable>
      <Under message={message} moves={moves} mine />
    </View>
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
      <View className="flex-shrink gap-1">
        <Pressable onLongPress={() => offer(message, moves)} delayLongPress={350} className="gap-1">
          {item.first ? <Text className="pl-1 text-sm text-ink-3">{authorOf(message, moves.self)}</Text> : null}
          {message.replyTo ? <Quote answered={message.replyTo} self={moves.self} mine={false} /> : null}
          <Body body={message.body}>
            <View className="self-start bg-surface-2 px-3.5 py-2.5" style={runCorners(item)}>
              <Words body={message.body} className="text-md text-ink" />
            </View>
          </Body>
        </Pressable>
        <Under message={message} moves={moves} mine={false} />
      </View>
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

/**
 * What the reader can do with the conversation's messages, as the server takes them, and its words when one fails;
 * `orclings`, whether a message may call one of the reader's Orclings.
 */
function useMessageMoves(lease: TeamChatLease, target: TeamChatTarget): { moves: MessageMoves; failure: string | null; orclings: boolean } {
  const state = teamChat.useChatState(lease).data;
  const chat = state?.state === "ready" ? state.chat : null;
  const joined = chat?.conversations.find((each) => each.id === target.conversationId)?.joined === true;
  const [failure, setFailure] = useState<string | null>(null);
  const failed = (error: Error) => setFailure(error.message);
  const moves: MessageMoves = {
    lease,
    self: lease.accountId,
    retryCall: (call) => void teamChat.retryCall(lease, target, call).catch(failed),
    react: (message, emoji) => void teamChat.react(lease, target, message, emoji).catch(failed),
    reply: chat?.features.includes("replies") ? (message) => teamChat.drafts.reply(target, answeredOf(message)) : null,
    pin: chat?.features.includes("pins") && joined ? (message) => void teamChat.pin(lease, target, message, !message.pinned).catch(failed) : null,
  };
  return { moves, failure, orclings: Boolean(chat?.features.includes("orcling")) };
}

/** One conversation of the organization's chat, in the desktop's shape: its messages live, earlier ones a tap away, and a composer that keeps its draft. */
function Conversation({ lease, conversationId, title, newFrom, jump }: { lease: TeamChatLease; conversationId: string; title: string; newFrom: number | null; jump: ChatJump | null }) {
  const insets = useSafeAreaInsets();
  const target = useMemo(() => ({ accountId: lease.accountId, spaceId: lease.spaceId, conversationId }), [lease, conversationId]);
  teamChat.useWatch(lease, conversationId);
  const timeline = teamChat.useTimeline(lease, conversationId);
  const draft = teamChat.useDraft(target);
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
  const { moves, failure, orclings } = useMessageMoves(lease, target);
  const send = (message: PendingTeamMessage) => void teamChat.send(lease, target, message).catch(() => undefined);
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
          orclings={orclings}
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

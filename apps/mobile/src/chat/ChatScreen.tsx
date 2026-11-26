import { answeredName, answeredOf, stretchTime, teamConversationTitle, withUnsent, type TeamChatLease, type TeamChatTarget } from "@openorc/client";
import { TeamChatReaction, type TeamChatAnswered, type TeamConversation, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Pressable, View, type ScrollViewInstance } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import Animated, { FadeInDown, LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamChat } from "../client";
import { Pin } from "../generated/icons";
import { WorkingMark } from "../ui/StateMark";
import { cn } from "../ui/cn";
import { useMeasuredSides } from "../ui/pane";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { chatItems, type ChatItem } from "./chat-items";
import { CallLine } from "./CallLine";
import { ChatFiles, ChatFileScopeContext, chatFileScope } from "./ChatFiles";
import { ChatComposer } from "./ChatComposer";
import { ActorFace, authorOf } from "./Author";
import { useChatLease } from "./lease";
import { useAskedJump, useMessageReveal, useRevealScroll, type ChatJump } from "./reveal";
import { Reactions } from "./Reactions";

/** A message the draft began, on its way or kept after it did not go. */
type PendingTeamMessage = NonNullable<ReturnType<typeof teamChat.drafts.begin>>;

/** The newest row rises in as it lands; earlier pages never move. */
const ARRIVE = FadeInDown.duration(220).withInitialValues({ transform: [{ translateY: 6 }] });

/** The face beside the last of a run, and the room it keeps at the bubbles' left. */
const FACE = 28;
const BUBBLE_RADIUS = 18;
/** Within a run, the corners that face another bubble close to 6, as on the Mac. */
const runCorners = (item: { first: boolean; last: boolean }) => ({
  borderRadius: BUBBLE_RADIUS,
  borderTopLeftRadius: item.first ? BUBBLE_RADIUS : 6,
  borderBottomLeftRadius: item.last ? BUBBLE_RADIUS : 6,
});

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
  /** Tries again a message of the reader's that did not go, with its same id. */
  resend: (message: PendingTeamMessage) => void;
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

/**
 * The reader's own message on the right, in the phone's prompt bubble. One on its way is faint, with nothing to do to
 * it yet; one that did not go has Retry under it, as the desktop draws them.
 */
function Mine({ message, moves, sending }: { message: TeamMessage; moves: MessageMoves; sending: PendingTeamMessage | undefined }) {
  const failed = sending?.state === "failed";
  return (
    <View accessibilityLabel={sending && !failed ? "Sending" : undefined} className="items-end gap-1 self-end" style={{ maxWidth: "88%" }}>
      <Pressable onLongPress={sending ? undefined : () => offer(message, moves)} delayLongPress={350} className="items-end gap-1">
        {message.replyTo ? <Quote answered={message.replyTo} self={moves.self} mine /> : null}
        <Body body={message.body}>
          <View className={cn("rounded-2xl bg-bubble px-4 py-3", sending && !failed && "opacity-60")}>
            <Words body={message.body} className="text-md text-bubble-ink" />
          </View>
        </Body>
      </Pressable>
      {sending ? null : <Under message={message} moves={moves} mine />}
      {failed ? (
        <Pressable accessibilityRole="button" accessibilityHint={sending.error ?? undefined} onPress={() => moves.resend(sending)} hitSlop={8} className="flex-row gap-1.5 active:opacity-60">
          <Text className="text-sm text-bad">Message not sent</Text>
          <Text className="text-sm text-ink-2">Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
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

function Row({ item, moves, onNew, unsent }: { item: ChatItem; moves: MessageMoves; onNew: (y: number) => void; unsent: ReadonlyMap<string, PendingTeamMessage> }) {
  switch (item.kind) {
    case "time":
      return <Text className="text-center text-xs text-ink-4">{stretchTime(item.at)}</Text>;
    case "new":
      return <NewLine onLayout={onNew} />;
    case "mine":
      return <Mine message={item.message} moves={moves} sending={unsent.get(item.message.id)} />;
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
    resend: (message) => void teamChat.send(lease, target, message).catch(() => undefined),
    reply: chat?.features.includes("replies") ? (message) => teamChat.drafts.reply(target, answeredOf(message)) : null,
    pin: chat?.features.includes("pins") && joined ? (message) => void teamChat.pin(lease, target, message, !message.pinned).catch(failed) : null,
  };
  return { moves, failure, orclings: Boolean(chat?.features.includes("orcling")) };
}

/** One conversation of the organization's chat, in the desktop's shape: its messages live, earlier ones a tap away, and a composer that keeps its draft. */
function Conversation({ lease, conversationId, title, newFrom, jump }: { lease: TeamChatLease; conversationId: string; title: string; newFrom: number | null; jump: ChatJump | null }) {
  const insets = useSafeAreaInsets();
  const sides = useMeasuredSides(12);
  const target = useMemo(() => ({ accountId: lease.accountId, spaceId: lease.spaceId, conversationId }), [lease, conversationId]);
  teamChat.useWatch(lease, conversationId);
  const timeline = teamChat.useTimeline(lease, conversationId);
  const draft = teamChat.useDraft(target);
  const list = useRef<ScrollViewInstance>(null);
  // Following the end until the reader scrolls up; an unread conversation opens at its New messages line instead, and
  // a search hit at its message.
  const atEnd = useRef(jump === null);
  const opened = useRef(jump !== null);
  // A pin asks the conversation already open to show its message, as a search hit opens one at it.
  const asked = useAskedJump(conversationId);
  const reveal = useMessageReveal(lease, conversationId, timeline.data, asked ?? jump);
  const onRowLayout = useRevealScroll(list, reveal, () => (atEnd.current = false));
  const files = useMemo(() => chatFileScope(lease.spaceId, conversationId), [lease, conversationId]);
  const messages = useMemo(() => timeline.data?.messages ?? [], [timeline.data]);
  const drawn = useMemo(() => withUnsent(messages, draft.pending, conversationId, { id: lease.accountId, name: "You", image: null }), [messages, draft.pending, conversationId, lease.accountId]);
  const items = useMemo(() => chatItems(drawn.messages, lease.accountId, newFrom), [drawn.messages, lease.accountId, newFrom]);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    if (lastId) void teamChat.seen(lease, target, { id: lastId }).catch(() => undefined);
  }, [lease, target, lastId]);
  const { moves, failure, orclings } = useMessageMoves(lease, target);
  const write = () => {
    const message = teamChat.drafts.begin(target);
    if (!message) return;
    atEnd.current = true;
    moves.resend(message);
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
          contentContainerStyle={{ paddingHorizontal: sides, paddingTop: 12, paddingBottom: 12 }}
        >
          {timeline.data?.older ? (
            <Pressable accessibilityRole="button" onPress={() => void teamChat.earlier(lease, conversationId)} className="items-center py-3 active:opacity-60">
              <Text className="text-sm text-ink-3">Earlier messages</Text>
            </Pressable>
          ) : null}
          {!timeline.data && !timeline.error ? <WorkingMark /> : null}
          {timeline.error ? <Text className="px-5 py-10 text-center text-ink-4">{timeline.error.message}</Text> : null}
          {timeline.data && !drawn.messages.length ? <Text className="py-10 text-center text-ink-4">No messages yet</Text> : null}
          {timeline.data ? (
            // The rows the conversation opens with skip their entrance; only what lands after rises in.
            <LayoutAnimationConfig skipEntering>
              {items.map((item, index) => (
                <Animated.View
                  key={item.key}
                  entering={index === items.length - 1 ? ARRIVE : undefined}
                  style={{ paddingTop: item.gap }}
                  onLayout={"message" in item ? ({ nativeEvent }) => onRowLayout(item.message.id, nativeEvent.layout.y) : undefined}
                >
                  <Row item={item} moves={moves} onNew={openAtNew} unsent={drawn.unsent} />
                </Animated.View>
              ))}
            </LayoutAnimationConfig>
          ) : null}
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

/** The header's way to the conversation's pinned messages, where the organization's chat keeps pins. */
function PinsButton({ conversationId }: { conversationId: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Pinned" hitSlop={8} onPress={() => router.push({ pathname: "/chat-pins", params: { id: conversationId } })} className="active:opacity-60">
      <Pin size={20} className="text-ink" />
    </Pressable>
  );
}

/** A conversation's name as the list names it: a channel by # and its name, a group by its people. */
const conversationTitle = (conversation: TeamConversation, self: string): string =>
  conversation.kind === "channel" ? `#${conversation.name ?? "channel"}` : teamConversationTitle(conversation, self);

/** A conversation of the shown organization's team chat, pushed over Home from its Chat tab, named as the list names it. */
export function ChatScreen() {
  const { id, message, seq } = useLocalSearchParams<{ id: string; message?: string; seq?: string }>();
  const jump = useMemo(() => (message && seq ? { id: message, seq: Number(seq), key: "opened" } : null), [message, seq]);
  const lease = useChatLease();
  const state = teamChat.useChatState(lease).data;
  const conversation = state?.state === "ready" ? state.chat.conversations.find((each) => each.id === id) : undefined;
  const title = conversation ? conversationTitle(conversation, lease?.accountId ?? "") : "";
  // The reader's place as the conversation opened, which the New messages line keeps while it stays open.
  const [newFrom, setNewFrom] = useState<number | null | undefined>(undefined);
  // A conversation just opened, as a first message to a person, is not listed yet: it opens with no line.
  const read = conversation?.read;
  const pins = state?.state === "ready" && state.chat.features.includes("pins");
  if (newFrom === undefined && state?.state === "ready") setNewFrom(read && read.unread > 0 ? read.seenSeq : null);
  return (
    <>
      <Stack.Screen options={{ headerTitle: title, headerRight: pins ? () => <PinsButton conversationId={id} /> : undefined }} />
      {lease && newFrom !== undefined ? (
        <Conversation key={`${lease.generation}:${id}`} lease={lease} conversationId={id} title={title} newFrom={newFrom} jump={jump} />
      ) : (
        <View className="flex-1 bg-bg" />
      )}
    </>
  );
}

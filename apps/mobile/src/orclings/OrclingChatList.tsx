import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { chatRows, stretchTime, type Block } from "@openorc/client";
import { Reaction, reactionEmoji, type OrclingChatSummary } from "@openorc/protocol";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card } from "../thread/cards";
import { VisualizationRow } from "../thread/VisualizationRow";
import { Markdown } from "../thread/Markdown";
import { Prompt } from "../thread/messages";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { bubbleTint, chatItems, type ChatItem } from "./chat-items";
import { OrclingFace } from "./OrclingFace";
import { reactionKey, useReactions } from "./use-reactions";

type Reactions = ReturnType<typeof useReactions>;
type Bubble = Extract<ChatItem, { kind: "bubble" }>;

/** The face beside a run's last bubble, as on the Mac, and the room it keeps beside the bubbles before it. */
const FACE = 28;
const BUBBLE_RADIUS = 18;
const AT_END = 24;

/** A tapback resting on a bubble's top corner, inside a ring of the ground. */
function Badge({ reaction }: { reaction: Reaction | undefined }) {
  if (!reaction) return null;
  return (
    <View accessibilityLabel={`Reacted ${reaction}`} className="absolute -right-2 -top-3 size-6 items-center justify-center rounded-full border-2 border-bg bg-surface">
      <Text className="text-xs">{reactionEmoji[reaction]}</Text>
    </View>
  );
}

/** Within a run, the corners that face another bubble close to 6, as on the Mac. */
const runCorners = (item: { first: boolean; last: boolean }) => ({
  borderRadius: BUBBLE_RADIUS,
  borderTopLeftRadius: item.first ? BUBBLE_RADIUS : 6,
  borderBottomLeftRadius: item.last ? BUBBLE_RADIUS : 6,
});

/** The person's message as the thread shows it, with the Orcling's tapback just before its top corner. */
function Mine({ block, reaction }: { block: Extract<Block, { kind: "message" }>; reaction: Reaction | undefined }) {
  return (
    <View className="flex-row items-start justify-end gap-1">
      {reaction ? (
        <View accessibilityLabel={`Reacted ${reaction}`} className="-mt-2 size-6 items-center justify-center rounded-full bg-surface">
          <Text className="text-xs">{reactionEmoji[reaction]}</Text>
        </View>
      ) : null}
      <Prompt block={block} />
    </View>
  );
}

/** The six tapbacks over a bubble that was held; choosing the current one takes it back. */
function ReactionBar({ current, onReact }: { current: Reaction | undefined; onReact: (reaction: Reaction | null) => void }) {
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="React" className="absolute -top-12 left-0 z-10 flex-row gap-0.5 rounded-full bg-surface p-1">
      {Reaction.options.map((reaction) => (
        <Pressable
          key={reaction}
          accessibilityRole="button"
          accessibilityLabel={reaction}
          accessibilityState={{ selected: current === reaction }}
          onPress={() => onReact(current === reaction ? null : reaction)}
          className={cn("size-9 items-center justify-center rounded-full", current === reaction ? "bg-surface-3" : "active:bg-surface-2")}
        >
          <Text className="text-lg">{reactionEmoji[reaction]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** One bubble of the Orcling's on a tint of its body color; holding it offers the tapbacks. */
function TheirBubble({ item, chat, reactions, held, onHold }: { item: Bubble; chat: OrclingChatSummary; reactions: Reactions; held: boolean; onHold: (key: string | null) => void }) {
  const mode = useMode();
  const key = reactionKey(item.block.runId, item.block.id, item.part);
  const current = reactions.person(key);
  const runId = item.block.runId;
  return (
    <View className="flex-row items-end gap-2" style={{ paddingRight: 48 }}>
      <View style={{ width: FACE }}>{item.last ? <OrclingFace look={chat.look} size={FACE} /> : null}</View>
      <View className="flex-shrink">
        {held && runId ? (
          <ReactionBar
            current={current}
            onReact={(reaction) => {
              haptic.select();
              reactions.choose({ runId, messageId: item.block.id, part: item.part }, reaction);
              onHold(null);
            }}
          />
        ) : null}
        <Pressable
          accessibilityHint="Hold to react"
          delayLongPress={300}
          onLongPress={() => {
            if (!runId) return;
            haptic.select();
            onHold(held ? null : key);
          }}
          className="px-3.5 py-2.5"
          style={{ backgroundColor: bubbleTint(chat.look.bodyColor, mode), ...runCorners(item) }}
        >
          <Markdown text={item.text} streaming={false} />
        </Pressable>
        <Badge reaction={current} />
      </View>
    </View>
  );
}

const dot = (delay: number) =>
  ({
    animationName: { from: { opacity: 1 }, to: { opacity: 0.25 } },
    animationDuration: "0.7s",
    animationDelay: `${delay}ms`,
    animationIterationCount: "infinite",
    animationDirection: "alternate",
  }) as const;

/** Three pulsing dots in a bubble while the Orcling works, always the run's last, so its face sits beside them. */
function Typing({ chat, first }: { chat: OrclingChatSummary; first: boolean }) {
  const mode = useMode();
  const still = useReducedMotion();
  return (
    <View className="flex-row items-end gap-2">
      <View style={{ width: FACE }}>
        <OrclingFace look={chat.look} size={FACE} />
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Typing"
        className="h-9 flex-row items-center gap-1 px-3.5"
        style={{ backgroundColor: bubbleTint(chat.look.bodyColor, mode), ...runCorners({ first, last: true }) }}
      >
        {[0, 160, 320].map((delay) => (
          <Animated.View key={delay} className="size-1.5 rounded-full bg-ink-3" style={still ? undefined : dot(delay)} />
        ))}
      </View>
    </View>
  );
}

const ChatRowView = memo(function ChatRowView({
  item,
  chat,
  runId,
  reactions,
  held,
  onHold,
}: {
  item: ChatItem;
  chat: OrclingChatSummary;
  runId: string;
  reactions: Reactions;
  held: string | null;
  onHold: (key: string | null) => void;
}) {
  switch (item.kind) {
    case "time":
      return <Text className="text-center text-xs text-ink-4">{stretchTime(item.at)}</Text>;
    case "mine":
      return <Mine block={item.block} reaction={reactions.orcling(reactionKey(item.block.runId, item.block.id, 0))} />;
    case "bubble":
      return <TheirBubble item={item} chat={chat} reactions={reactions} held={held === reactionKey(item.block.runId, item.block.id, item.part)} onHold={onHold} />;
    case "card":
      return <Card block={item.block} runId={item.block.runId ?? runId} />;
    case "visualization":
      return <VisualizationRow row={{ kind: "visualization", key: item.key, gap: 0, runId: item.row.block.runId ?? runId, block: item.row.block, visualization: item.row.visualization }} />;
    case "typing":
      return <Typing chat={chat} first={item.first} />;
  }
});

export interface OrclingChatListProps {
  chat: OrclingChatSummary;
  blocks: Block[];
  /** The Orcling is at work: the dots show until it texts. */
  typing: boolean;
  runId: string;
  hasOlder: boolean;
  loadOlder: () => void;
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  /** Changes when the person sends, which returns the view to the newest message. */
  followKey: number;
}

const keyOf = (item: ChatItem) => item.key;
const kindOf = (item: ChatItem) => item.kind;
const contentStyle = { paddingHorizontal: 12 };
const footer = <View className="h-4" />;

/**
 * An Orcling's own conversation the way people text, as its chat on the Mac reads: the person's messages on the right,
 * the Orcling's on the left beside its face, one bubble per paragraph, typing dots while it works, and tapbacks both
 * ways. Its tools and thoughts stay out of sight; what needs the person shows as the thread's own cards.
 */
export function OrclingChatList({ chat, blocks, typing, runId, hasOlder, loadOlder, composerInset, listRef, followKey }: OrclingChatListProps) {
  const insets = useSafeAreaInsets();
  const reactions = useReactions(chat.threadId);
  const [held, setHeld] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const items = useMemo(() => chatItems(chatRows(blocks), typing), [blocks, typing]);
  // A page that leaves the top in view asks for the next, as the thread's transcript does.
  useEffect(() => {
    const state = listRef.current?.getState();
    if (hasOlder && state && state.contentLength <= state.scrollLength) loadOlder();
  }, [items, hasOlder, loadOlder, listRef]);
  const sent = useRef(followKey);
  useEffect(() => {
    if (sent.current === followKey) return;
    sent.current = followKey;
    setFollowing(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, [followKey, listRef]);
  const onScroll = useCallback(({ nativeEvent }: { nativeEvent: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } } }) => {
    const { contentOffset, layoutMeasurement, contentSize } = nativeEvent;
    setFollowing(contentOffset.y + layoutMeasurement.height >= contentSize.height - AT_END);
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => (
      <View style={{ paddingTop: item.gap }}>
        <ChatRowView item={item} chat={chat} runId={runId} reactions={reactions} held={held} onHold={setHeld} />
      </View>
    ),
    [chat, runId, reactions, held],
  );
  return (
    <KeyboardAwareLegendList
      ref={listRef}
      data={items}
      keyExtractor={keyOf}
      getItemType={kindOf}
      renderItem={renderItem}
      extraData={held}
      estimatedItemSize={56}
      initialScrollAtEnd
      alignItemsAtEnd
      maintainScrollAtEnd={following ? { animated: false } : false}
      maintainVisibleContentPosition={{ data: true }}
      onStartReached={hasOlder ? loadOlder : undefined}
      onStartReachedThreshold={1}
      onScroll={onScroll}
      onScrollBeginDrag={() => setHeld(null)}
      scrollEventThrottle={32}
      contentInsetEndAdjustment={composerInset}
      keyboardLiftBehavior="whenAtEnd"
      keyboardOffset={insets.bottom}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={hasOlder ? <View className="h-12 items-center justify-center">{<Spinner />}</View> : null}
      ListFooterComponent={footer}
      contentContainerStyle={contentStyle}
    />
  );
}

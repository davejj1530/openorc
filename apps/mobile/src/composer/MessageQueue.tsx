import type { QueuedMessage } from "@openorc/protocol";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { ChevronDown, X } from "../generated/icons";
import { arrive } from "../ui/motion";
import { Text } from "../ui/Text";

/** A queued message's words: two lines, or all of them once tapped. */
function QueuedText({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: full }} onPress={() => setFull(!full)}>
      <Text numberOfLines={full ? undefined : 2}>{text}</Text>
    </Pressable>
  );
}

/** About two rows: what the fanned-out pile may take while the keyboard is up, so the composer stays under the header. */
const TYPING_HEIGHT = 104;
const OPEN_HEIGHT = 220;

/**
 * Messages waiting for the turn to finish, as a pile above the composer: a front card with the count and up to two
 * cards behind it. Tapping it fans the pile out into the messages, each with Send now and Remove; tapping a message
 * shows all of it. A message that failed to send opens it on its own.
 */
export function MessageQueue({
  messages,
  canSend,
  pending,
  agentName,
  typing,
  onSend,
  onRemove,
}: {
  messages: QueuedMessage[];
  canSend: boolean;
  pending: boolean;
  agentName: string;
  /** The prompt has the keyboard up. */
  typing: boolean;
  onSend: (messageId: string) => void;
  onRemove: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const still = useReducedMotion();
  if (!messages.length) return null;
  const open = expanded || messages.some((message) => message.error || message.interrupted);
  const behind = open ? 0 : Math.min(2, messages.length - 1);
  return (
    <View accessibilityLabel="Queued messages" className="gap-1 px-3.5">
      {open ? (
        // With the keyboard up, a tap on Send now, Remove or a message does its job rather than only lowering the keyboard.
        <ScrollView style={{ maxHeight: typing ? TYPING_HEIGHT : OPEN_HEIGHT }} keyboardShouldPersistTaps="handled" scrollsToTop={false} contentContainerClassName="gap-1">
          {messages.map((message, index) => (
            <Animated.View key={message.id} className="min-h-touch flex-row items-center gap-2 rounded-lg bg-surface py-1.5 pl-3.5 pr-1.5" style={still ? undefined : arrive}>
              <View className="min-w-0 flex-1 gap-1">
                <QueuedText text={message.text.trim() || "Attached images"} />
                {message.error ? <Text className="text-sm text-bad">{message.error}</Text> : null}
                {message.attachments.length ? (
                  <Text className="text-sm text-ink-4">
                    {message.attachments.length} {message.attachments.length === 1 ? "image" : "images"} attached
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={(!canSend && !message.interrupted) || pending}
                onPress={() => onSend(message.id)}
                hitSlop={{ top: 8, bottom: 8 }}
                className="h-control-sm justify-center rounded-full px-2.5 active:bg-surface-2"
              >
                <Text className={(!canSend && !message.interrupted) || pending ? "text-sm text-ink-4" : "text-sm text-ink-2"}>{message.interrupted ? "Retry" : "Send now"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove queued message ${index + 1}`}
                disabled={pending}
                onPress={() => onRemove(message.id)}
                className="size-touch items-center justify-center rounded-full active:bg-surface-2"
              >
                <X size={13} className="text-ink-4" />
              </Pressable>
            </Animated.View>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ paddingTop: behind * 5 }}>
        {Array.from({ length: behind }, (_, depth) => (
          <View
            key={depth}
            className="absolute inset-x-0 top-0 h-touch rounded-lg bg-surface"
            style={{ opacity: depth === 0 ? 0.5 : 0.75, transform: [{ translateY: (behind - depth - 1) * 5 }, { scale: depth === 0 && behind === 2 ? 0.94 : 0.97 }] }}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setExpanded(!open)}
          className="min-h-touch flex-row items-center gap-2.5 rounded-lg bg-surface pl-3.5 pr-3 active:bg-surface-3"
        >
          <Text className="tabular-nums">{messages.length} queued</Text>
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-ink-4">
            Sends when {agentName} finishes
          </Text>
          <View style={{ transform: [{ rotate: open ? "0deg" : "180deg" }] }}>
            <ChevronDown size={14} className="text-ink-4" />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

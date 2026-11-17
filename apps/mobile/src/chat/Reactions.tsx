import { TeamChatReaction, type TeamMessage } from "@openorc/protocol";
import { Pressable, View } from "react-native";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";

/** The reactions under a message, as the desktop draws them: the count past one, the reader's own marked; a tap takes the reader's back or adds it. */
export function Reactions({ message, self, mine, onReact }: { message: TeamMessage; self: string; mine: boolean; onReact: (emoji: TeamChatReaction) => void }) {
  if (!message.reactions.length) return null;
  return (
    <View className={cn("flex-row flex-wrap gap-1", mine && "justify-end")}>
      {message.reactions.map(({ emoji, userIds }) => {
        const reaction = TeamChatReaction.safeParse(emoji);
        const own = userIds.includes(self);
        return (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={`${emoji}, ${userIds.length} reactions`}
            accessibilityState={{ selected: own, disabled: !reaction.success }}
            disabled={!reaction.success}
            onPress={() => reaction.success && onReact(reaction.data)}
            className={cn("h-7 flex-row items-center gap-1 rounded-full px-2.5 active:opacity-60", own ? "bg-surface-3" : "bg-surface-2")}
          >
            <Text className="text-sm">{emoji}</Text>
            {userIds.length > 1 ? <Text className="text-xs tabular-nums text-ink-3">{userIds.length}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

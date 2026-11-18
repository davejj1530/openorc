import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** When a listing or a file the phone keeps was read, said while the Mac is out of reach. */
export const readAt = (at: number): string => `Read at ${time.format(at)}`;

/** What stands in for a folder's entries or a file's text: the Mac's words or the desktop's, and Retry where asking again can help. */
export function FilesNotice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <View className="items-center gap-2 px-8 py-10">
      <Text className="text-center text-ink-4">{text}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} className="min-h-touch justify-center rounded-full px-4 active:bg-surface-2">
          <Text className="text-ink-2">Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

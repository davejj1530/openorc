import { createContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

/** Set where words selected in the conversation can be quoted: it hands the passage to the thread's composer. */
export const QuoteContext = createContext<((text: string) => void) | null>(null);

/** A quoted passage, behind a hairline as the desktop sets one apart. */
export function Passage({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row gap-2.5">
      <View className="bg-line-strong" style={{ width: StyleSheet.hairlineWidth }} />
      <View className="min-w-0 flex-1">{children}</View>
    </View>
  );
}

import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View, type HostInstance } from "react-native";
import { monoLines, monoMetrics } from "../thread/mono-lines";
import { useChunksInView } from "../thread/sheet-window";
import { cn } from "./cn";
import { haptic } from "./haptics";
import { Text } from "./Text";

export const MONO = "font-mono text-xs leading-5";

/**
 * Copies the whole text as the agent wrote it. A long press on the block selects only the lines drawn in one piece,
 * which a long command or output spans many of, and lines past the drawn width are cut.
 */
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        void Clipboard.setStringAsync(text).then(() => {
          haptic.tap();
          setCopied(true);
        })
      }
      hitSlop={{ top: 14, bottom: 14, left: 12, right: 12 }}
      className="active:opacity-60"
    >
      <Text className="text-xs leading-4 text-ink-4">{copied ? "Copied" : "Copy"}</Text>
    </Pressable>
  );
}

/**
 * Monospace text that scrolls sideways; a long one shows its first lines and offers the rest. Only the lines near the
 * screen are drawn, so even a megabyte of output costs a screen or two of drawing. `lineTone` colors a line by its text
 * and its place in the whole text.
 */
export function Mono({ text, tone = "text-ink-2", lineTone }: { text: string; tone?: string; lineTone?: (line: string, index: number) => string }) {
  const [all, setAll] = useState(false);
  const { fontScale } = useWindowDimensions();
  const metrics = useMemo(() => monoMetrics(fontScale), [fontScale]);
  const { chunks, total, columns } = useMemo(() => monoLines(text, all, metrics), [text, all, metrics]);
  const column = useRef<HostInstance>(null);
  const {
    range: [first, last],
    measure,
  } = useChunksInView(column, chunks.length, metrics.chunkHeight);
  const shown = chunks.reduce((count, chunk) => count + chunk.length, 0);
  return (
    <View className="gap-1.5">
      <ScrollView horizontal scrollsToTop={false} showsHorizontalScrollIndicator={false} className="rounded-xl bg-surface-2" contentContainerClassName="px-4 py-3">
        <View ref={column} onLayout={measure} style={{ minWidth: columns * metrics.char }}>
          {chunks.map((lines, index) =>
            index < first || index > last ? (
              <View key={index} style={{ height: lines.length * metrics.line }} />
            ) : (
              <Text key={index} prose selectable className={cn("self-start", MONO, tone)}>
                {lineTone
                  ? lines.map((line, at) => (
                      // The shared Text sets the interface face on every Text, nested ones too.
                      <Text key={at} prose className={cn(MONO, lineTone(line, index * metrics.chunkLines + at))}>
                        {at ? `\n${line}` : line}
                      </Text>
                    ))
                  : lines.join("\n")}
              </Text>
            ),
          )}
        </View>
      </ScrollView>
      <View className="flex-row items-center justify-between px-1">
        {shown < total ? (
          <Pressable accessibilityRole="button" onPress={() => setAll(true)} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }} className="active:opacity-60">
            <Text className="text-xs leading-4 text-ink-4">Show all {total} lines</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <CopyText text={text} />
      </View>
    </View>
  );
}

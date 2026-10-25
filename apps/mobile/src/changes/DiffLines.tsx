import { memo, useMemo, useRef } from "react";
import { ScrollView, useWindowDimensions, View, type HostInstance } from "react-native";
import { monoMetrics, type MonoMetrics } from "../thread/mono-lines";
import { useChunksInView } from "../thread/sheet-window";
import { cn } from "../ui/cn";
import { MONO } from "../ui/Mono";
import { Text } from "../ui/Text";
import { diffChunks, diffRows, type DiffChunk, type DiffRow, type DiffRun } from "./diff-lines";

// The desktop's plain diff tones (DiffView's PLAIN_LINES): no syntax colors, added and removed lines on their soft fills.
const tints: Record<DiffRun["kind"], string> = { add: "bg-ok-soft", del: "bg-bad-soft", hunk: "bg-surface-2" };
const inks: Record<DiffRow["kind"], string> = { add: "text-ok", del: "text-bad", hunk: "text-ink-4", context: "text-ink-2", note: "text-ink-4" };
/** The code column's side padding, in points; the tints run under it. */
const PAD = 12;

/** One chunk's code: a tint per run of added or removed lines behind one Text, each line in its tone. */
const CodeChunk = memo(function CodeChunk({ chunk, metrics }: { chunk: DiffChunk; metrics: MonoMetrics }) {
  const lines = chunk.code.split("\n");
  return (
    <View style={{ height: lines.length * metrics.line }}>
      {chunk.runs.map((run) => (
        <View key={run.start} className={cn("absolute inset-x-0 rounded-sm", tints[run.kind])} style={{ top: run.start * metrics.line, height: run.length * metrics.line }} />
      ))}
      <Text prose selectable className={cn("self-start", MONO)} style={{ paddingHorizontal: PAD }}>
        {lines.map((line, at) => (
          // The shared Text sets the interface face on every Text, nested ones too.
          <Text key={at} prose className={cn(MONO, inks[chunk.kinds[at]!])}>
            {at ? `\n${line}` : line}
          </Text>
        ))}
      </Text>
    </View>
  );
});

/**
 * A file's diff as two columns in one vertical scroll: line numbers that stay put, and the code, which scrolls
 * sideways. Only the chunks near the screen draw, so a 5,000-line diff costs about two screens of text.
 */
export function DiffLines({ patch }: { patch: string }) {
  const { fontScale } = useWindowDimensions();
  const metrics = useMemo(() => monoMetrics(fontScale), [fontScale]);
  const rows = useMemo(() => diffRows(patch), [patch]);
  const chunks = useMemo(() => diffChunks(rows, metrics), [rows, metrics]);
  const { digits, columns } = useMemo(
    () => ({
      digits: String(rows.reduce((widest, row) => Math.max(widest, row.number ?? 0), 0)).length,
      columns: chunks.reduce((widest, chunk) => Math.max(widest, ...chunk.code.split("\n").map((line) => line.length)), 0),
    }),
    [rows, chunks],
  );
  const column = useRef<HostInstance>(null);
  const {
    range: [first, last],
    measure,
  } = useChunksInView(column, chunks.length, metrics.chunkHeight);
  const shown = (index: number) => index >= first && index <= last;
  const height = (chunk: DiffChunk) => chunk.code.split("\n").length * metrics.line;
  return (
    <View ref={column} onLayout={measure} className="flex-row">
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: digits * metrics.char + PAD * 2 }}>
        {chunks.map((chunk, index) =>
          shown(index) ? (
            <Text key={index} prose className={cn("text-right text-ink-4", MONO)} style={{ height: height(chunk), paddingHorizontal: PAD }}>
              {chunk.gutter}
            </Text>
          ) : (
            <View key={index} style={{ height: height(chunk) }} />
          ),
        )}
      </View>
      <ScrollView horizontal scrollsToTop={false} showsHorizontalScrollIndicator={false} className="flex-1" contentContainerStyle={{ flexGrow: 1, paddingRight: PAD }}>
        <View style={{ minWidth: columns * metrics.char + PAD * 2, flexGrow: 1 }}>
          {chunks.map((chunk, index) => (shown(index) ? <CodeChunk key={index} chunk={chunk} metrics={metrics} /> : <View key={index} style={{ height: height(chunk) }} />))}
        </View>
      </ScrollView>
    </View>
  );
}

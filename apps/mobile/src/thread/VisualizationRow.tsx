import { memo, useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useOpen } from "./disclosure";
import type { Row } from "./rows";
import { PlainToolRow } from "./tools";
import { FIRST_HEIGHT, type FrameMemory } from "./visualization-frame";
import { FrameFailure, VisualizationFrame } from "./VisualizationFrame";
import { SETTLE_MS, useFrame, useFrameWindow } from "./visualization-window";

/**
 * Whether the row has stayed in its view for a moment. The list moves rows between views while it lays out and as rows
 * land, and a web view started in a row about to move is thrown away with it, a page load and a UI hitch for nothing.
 */
function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  return settled;
}

/** A frame without its web view, in the space it last took. */
function KeptFrame({ memory }: { memory: FrameMemory | undefined }) {
  return memory?.kind === "failed" ? <FrameFailure message={memory.message} /> : <View style={{ height: memory?.height ?? FIRST_HEIGHT }} />;
}

function TextButton({ label, expanded, onPress }: { label: string; expanded?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={expanded === undefined ? undefined : { expanded }} onPress={onPress} hitSlop={8} className="active:opacity-60">
      <Text className="text-xs text-ink-4">{label}</Text>
    </Pressable>
  );
}

/**
 * A visualization the agent drew, as the desktop shows it: its title with Reset and Hide or Show, its description
 * (which stands in when the page cannot render), the page in a frame as tall as it is, and a row that opens its source.
 * The frame holds a live web view only while the list says the row is among the few nearest the screen, once the row
 * has settled in its view; otherwise it shows what it last showed: its page's space, or its quiet line. Reset and Show
 * ask for a fresh page, as they do on the desktop.
 */
export const VisualizationRow = memo(function VisualizationRow({ row }: { row: Extract<Row, { kind: "visualization" }> }) {
  const { key, block, runId, visualization } = row;
  const [visible, setVisible] = useOpen(key, true);
  const [attempt, setAttempt] = useState(0);
  const frame = useFrame(key);
  const settled = useSettled();
  const live = frame.live && settled;
  const frames = useFrameWindow();
  const keep = useCallback((memory: FrameMemory) => frames.keep(key, memory), [frames, key]);
  const kept = frames.kept(key);
  const reset = () => {
    frames.retry(key);
    setAttempt((count) => count + 1);
  };
  const toggle = () => {
    if (!visible) frames.retry(key);
    setVisible(!visible);
  };
  return (
    <View accessibilityLabel={visualization.title}>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text accessibilityRole="header" className="text-md">
          {visualization.title}
        </Text>
        <View className="flex-row gap-3">
          {visible ? <TextButton label="Reset" onPress={reset} /> : null}
          <TextButton label={visible ? "Hide visualization" : "Show visualization"} expanded={visible} onPress={toggle} />
        </View>
      </View>
      <Text selectable className="my-2 text-sm text-ink-2">
        {visualization.description}
      </Text>
      {visible && live ? <VisualizationFrame key={attempt} title={visualization.title} html={visualization.html} shown={frame.shown} kept={kept} onKeep={keep} /> : null}
      {visible && !live ? <KeptFrame memory={kept} /> : null}
      <PlainToolRow block={block} runId={runId} label="View source" />
    </View>
  );
});

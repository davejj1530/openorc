import { memo } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { FileText, WorkMessage } from "../generated/icons";
import { Text } from "../ui/Text";
import { attachmentRef, ImageTile, isImagePath } from "./images";
import { client } from "../client";
import { runBlock, useRunRead } from "../run-read";
import { useOpen } from "./disclosure";
import { messagePieces } from "./markdown-chunks";
import { Markdown } from "./Markdown";
import type { MessageBlock, PieceSource } from "./rows";

/** The name the person gave an attachment, after the id that keeps it unique. */
function attachmentName(path: string): string {
  const stored = path.split(/[\\/]/).pop() ?? path;
  return /^[a-f0-9-]{36}-/.test(stored) ? stored.slice(37) : stored;
}

/** What the person wrote: an r18 plane bubble on the right, at most 88% wide, its images above it. */
export const Prompt = memo(function Prompt({ block }: { block: MessageBlock }) {
  const attachments = block.attachments ?? [];
  return (
    <View className="items-end gap-2 self-end" style={{ maxWidth: "88%" }}>
      {attachments.length ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          {attachments.map((path) =>
            isImagePath(path) ? (
              <ImageTile key={path} asset={attachmentRef(path)} label="Attached image" compact />
            ) : (
              <View key={path} className="h-control-row max-w-56 flex-row items-center gap-2 rounded-lg bg-surface-2 px-3">
                <FileText size={16} className="text-ink-4" />
                <Text numberOfLines={1} className="flex-shrink">
                  {attachmentName(path)}
                </Text>
              </View>
            ),
          )}
        </View>
      ) : null}
      {block.text ? (
        <View className="rounded-2xl bg-bubble px-4 py-3">
          <Text prose selectable className="text-md text-bubble-ink">
            {block.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

/**
 * OpenOrc talking in the thread, not the person and not the agent: a hand-off, a task's result. Its first line says
 * what happened; the rest (a task's whole report) stays folded behind a faint Show details.
 */
export const Notice = memo(function Notice({ block }: { block: MessageBlock }) {
  const [open, setOpen] = useOpen(`notice:${block.id}`, false);
  const [head, ...rest] = block.text.split("\n");
  const details = rest.join("\n").trim();
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3">
      <View className="mt-0.5">
        <WorkMessage size={16} className="text-ink-4" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text prose className="text-ink-2">
          {head}
        </Text>
        {details && open ? (
          <Text prose className="text-ink-3">
            {details}
          </Text>
        ) : null}
        {details ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            className="self-start active:opacity-60"
          >
            <Text className="text-sm text-ink-4">{open ? "Hide details" : "Show details"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const pulse = {
  animationName: { from: { opacity: 1 }, to: { opacity: 0.3 } },
  animationDuration: "1.4s",
  animationIterationCount: "infinite",
  animationDirection: "alternate",
  animationTimingFunction: "ease-out",
} as const;

/** Waiting on the first words: a small ink pulse leads the line. */
function Pending() {
  const still = useReducedMotion();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Writing response" className="min-h-5.5 flex-row items-center gap-2">
      <Animated.View className="size-2 rounded-full bg-ink" style={still ? undefined : pulse} />
      <Text className="text-ink-3">Writing response</Text>
    </View>
  );
}

/**
 * A piece's words. While it streams they are read from the run as they arrive, so a streamed word re-renders this
 * piece alone; once it is done it takes its text from the row and stops listening.
 */
function usePieceText({ runId, blockId, index }: PieceSource, text: string, streaming: boolean): string {
  return useRunRead(
    client.runs,
    (runs) => {
      if (!streaming) return text;
      const block = runBlock(runs, runId, blockId);
      return block?.kind === "message" ? (messagePieces(block)[index] ?? "") : text;
    },
    streaming,
  );
}

/**
 * A piece of the agent's answer as prose: unboxed Markdown in ink, the last piece streaming in place while the turn
 * writes it. The piece keeps one native view from its first word on, so finishing changes only how it draws.
 */
export const Reply = memo(function Reply({ text, streaming, source }: { text: string; streaming: boolean; source: PieceSource }) {
  const words = usePieceText(source, text, streaming);
  if (streaming && !words) return <Pending />;
  return <Markdown text={words} streaming={streaming} />;
});

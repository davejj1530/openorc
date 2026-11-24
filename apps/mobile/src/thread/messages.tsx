import { foldsWords, noticeFrom, oneLine, type NoticeFrom } from "@openorc/client";
import { hostedFileReference } from "@openorc/protocol";
import { router } from "expo-router";
import { memo, useMemo } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { FileText, WorkMessage } from "../generated/icons";
import { Text } from "../ui/Text";
import { attachmentRef, CloudImageTile, ImageTile, isImagePath } from "./images";
import { client } from "../client";
import { runBlock, useRunRead } from "../run-read";
import { useOpen } from "./disclosure";
import { openProof } from "./open-sheet";
import { messagePieces } from "./markdown-chunks";
import { Markdown } from "./Markdown";
import { replySegments } from "./reply-images";
import type { ReplyProof } from "./reply-proof";
import type { MessageBlock, PieceSource } from "./rows";
import { TranscriptPressable } from "./TranscriptPressable";
import { useOtherAuthor } from "./thread-authors";

/** The name the person gave an attachment, after the id that keeps it unique. */
function attachmentName(path: string): string {
  const stored = path.split(/[\\/]/).pop() ?? path;
  return /^[a-f0-9-]{36}-/.test(stored) ? stored.slice(37) : stored;
}

/** An image a person attached: one of the Mac's, or one a cloud thread's message carries, read from OpenOrc Cloud. */
function AttachedImage({ path }: { path: string }) {
  if (hostedFileReference(path)) return <CloudImageTile path={path} label="Attached image" compact />;
  return <ImageTile asset={attachmentRef(path)} label="Attached image" compact />;
}

/**
 * What a person wrote: an r18 plane bubble on the right, at most 88% wide, its images above it. In a cloud thread a
 * teammate's words carry their first name over the bubble; the reader's own carry none.
 */
export const Prompt = memo(function Prompt({ block }: { block: MessageBlock }) {
  const attachments = block.attachments ?? [];
  const author = useOtherAuthor(block.id);
  return (
    <View className="items-end gap-2 self-end" style={{ maxWidth: "88%" }}>
      {author ? <Text className="-mb-1 pr-1 text-xs text-ink-4">{author}</Text> : null}
      {attachments.length ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          {attachments.map((path) =>
            isImagePath(path) ? (
              <AttachedImage key={path} path={path} />
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
 * Words in the thread that are not the person's and not the agent's. Another thread's or an Orcling's read as a
 * message: who it is from, then what it said. OpenOrc's own (a hand-off, a task's result) read by their first line, the
 * rest (a task's whole report) folded behind a faint Show details.
 */
export const Notice = memo(function Notice({ block }: { block: MessageBlock }) {
  const from = useMemo(() => noticeFrom(block.text), [block.text]);
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3">
      <View className="mt-0.5">
        <WorkMessage size={16} className="text-ink-4" />
      </View>
      <View className="min-w-0 flex-1 gap-1">{from ? <Received id={block.id} from={from} /> : <Told id={block.id} text={block.text} />}</View>
    </View>
  );
});

function Told({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useOpen(`notice:${id}`, false);
  const [head, ...rest] = text.split("\n");
  const details = rest.join("\n").trim();
  return (
    <>
      <Text prose className="text-ink-2">
        {head}
      </Text>
      {details && open ? (
        <Text prose className="text-ink-3">
          {details}
        </Text>
      ) : null}
      {details ? <Fold open={open} onPress={() => setOpen(!open)} labels={["Show details", "Hide details"]} /> : null}
    </>
  );
}

/** A message from another thread: short ones whole, long ones by their first lines until asked for. */
function Received({ id, from }: { id: string; from: NoticeFrom }) {
  const [all, setAll] = useOpen(`notice:${id}`, false);
  const folds = foldsWords(from.text);
  return (
    <>
      <Sender name={from.name} lead={from.lead} threadId={from.threadId} />
      {folds && !all ? (
        <Text prose numberOfLines={4} className="text-ink-3">
          {oneLine(from.text)}
        </Text>
      ) : (
        <Markdown text={from.text} streaming={false} tone="note" />
      )}
      {folds ? <Fold open={all} onPress={() => setAll(!all)} labels={["Show all", "Show less"]} /> : null}
    </>
  );
}

/** Who wrote it. A thread's name opens that thread; an Orcling's chat is not a thread to open. */
function Sender({ lead, name, threadId }: { lead: string; name: string; threadId: string | null }) {
  const words = (
    <Text prose className="text-ink-3">
      {lead} <Text className="text-ink">{name}</Text>
    </Text>
  );
  if (!threadId) return words;
  return (
    <TranscriptPressable accessibilityRole="button" onPress={() => router.push({ pathname: "/thread/[id]", params: { id: threadId } })} className="self-start active:opacity-60">
      {words}
    </TranscriptPressable>
  );
}

function Fold({ open, onPress, labels }: { open: boolean; onPress: () => void; labels: [closed: string, opened: string] }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onPress} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }} className="self-start active:opacity-60">
      <Text className="text-sm text-ink-4">{labels[open ? 1 : 0]}</Text>
    </Pressable>
  );
}

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
export const Reply = memo(function Reply({ text, streaming, source, proofs }: { text: string; streaming: boolean; source: PieceSource; proofs: ReplyProof[] }) {
  const words = usePieceText(source, text, streaming);
  const segments = useMemo(() => replySegments(words), [words]);
  const pills = useMemo(() => (proofs.length ? { list: proofs, open: (proof: ReplyProof) => openProof(proof, source.runId) } : undefined), [proofs, source.runId]);
  if (streaming && !words) return <Pending />;
  if (!segments.some((segment) => segment.kind === "image")) return <Markdown text={words} streaming={streaming} proofs={pills} />;
  // The gap is a paragraph's own margin, so an image sits in the reply's rhythm.
  return (
    <View className="gap-3.5">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Markdown key={index} text={segment.text} streaming={streaming && index === segments.length - 1} proofs={pills} />
        ) : (
          <ReplyImage key={index} path={segment.path} alt={segment.alt} source={source} streaming={streaming} />
        ),
      )}
    </View>
  );
});

/**
 * An image the reply shows from a file on the Mac, fetched once the message is complete: the Mac serves it only to
 * the message that names it.
 */
function ReplyImage({ path, alt, source, streaming }: { path: string; alt: string; source: PieceSource; streaming: boolean }) {
  const label = alt || path.split(/[\\/]/).pop() || "Image";
  if (streaming) return <View className="w-full rounded-xl bg-surface-2" style={{ aspectRatio: 16 / 9 }} />;
  return <ImageTile asset={{ kind: "reply-image", runId: source.runId, messageId: source.blockId, path }} label={label} />;
}

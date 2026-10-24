import { liveVerb, stateLabel, toolCallPresentation, toolInputView, toolOutputView, toolResult, type InputView, type OutputView } from "@openorc/client";
import { TOOL_IMAGE_URL } from "@openorc/protocol";
import { useLocalSearchParams } from "expo-router";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, useWindowDimensions, View, type HostInstance, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { link, useLinkRead, useRun } from "../client";
import type { LinkRead } from "../connection/link-hooks";
import { cn } from "../ui/cn";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { ImageTile } from "./images";
import { matchLines, monoLines, monoMetrics } from "./mono-lines";
import { createSheetWindow, SheetWindowContext, useChunksInView } from "./sheet-window";
import { toolIcons, toolState, type ToolBlock } from "./tools";

/** Reads a call's output from the ledger; `key` names the run and the call. */
const readToolOutput = (key: string) => link.connection.call("events.toolOutput", JSON.parse(key) as { runId: string; toolCallId: string });

/** A page leaves large outputs out; the sheet reads the call's output from the ledger when it opens. */
function useToolOutput(block: ToolBlock | undefined): { output: unknown; state: LinkRead<unknown>["state"] } {
  const omitted = block?.outputOmitted && block.runId ? JSON.stringify({ runId: block.runId, toolCallId: block.id }) : null;
  const read = useLinkRead(omitted, readToolOutput);
  if (!omitted) return { output: block?.output, state: "ready" };
  return { output: read.state === "ready" ? (read.value.output ?? undefined) : undefined, state: read.state };
}

const MONO = "font-mono text-xs leading-5";

/**
 * Monospace text that scrolls sideways; a long one shows its first lines and offers the rest. Only the lines near the
 * screen are drawn, so even a megabyte of output costs a screen or two of drawing. `lineTone` colors a line by its text
 * and its place in the whole text.
 */
function Mono({ text, tone = "text-ink-2", lineTone }: { text: string; tone?: string; lineTone?: (line: string, index: number) => string }) {
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="rounded-xl bg-surface-2" contentContainerClassName="px-4 py-3">
        <View ref={column} onLayout={measure} style={{ minWidth: columns * metrics.char }}>
          {chunks.map((lines, index) =>
            index < first || index > last ? (
              <View key={index} style={{ height: lines.length * metrics.line }} />
            ) : (
              <Text key={index} selectable className={cn("self-start", MONO, tone)}>
                {lineTone
                  ? lines.map((line, at) => (
                      // The shared Text sets the interface face on every Text, nested ones too.
                      <Text key={at} className={cn(MONO, lineTone(line, index * metrics.chunkLines + at))}>
                        {at ? `\n${line}` : line}
                      </Text>
                    ))
                  : lines.join("\n")}
              </Text>
            ),
          )}
        </View>
      </ScrollView>
      {shown < total ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} hitSlop={8} className="self-start active:opacity-60">
          <Text className="text-xs leading-4 text-ink-4">Show all {total} lines</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <Text className="text-xs leading-4 text-ink-4">{children}</Text>;
}

function diffTone(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-ok";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-bad";
  return "text-ink-3";
}

/** A unified diff with its added and removed lines in the desktop's result tones. */
function Diff({ patch }: { patch: string }) {
  return <Mono text={patch} lineTone={diffTone} />;
}

/** Search results in one block, each file's path in the faint tone over its lines, so one line budget covers them all. */
function Matches({ groups }: { groups: Extract<OutputView, { kind: "matches" }>["groups"] }) {
  const { text, paths } = useMemo(() => matchLines(groups), [groups]);
  return <Mono text={text} lineTone={(_, index) => (paths.has(index) ? "text-ink-4" : "text-ink-2")} />;
}

const InputPart = memo(function InputPart({ view }: { view: InputView }) {
  switch (view.kind) {
    case "command":
      return (
        <View className="gap-1.5">
          <Mono tone="text-ink" text={view.steps.map((step) => `$ ${step.text}${step.body ? `\n${step.body.code}` : ""}`).join("\n")} />
          {view.cwd ? <Label>{view.cwd}</Label> : null}
        </View>
      );
    case "file":
      return <Mono tone="text-ink" text={view.lines ? `${view.path}  ${view.lines}` : view.path} />;
    case "patch":
      return <Diff patch={view.patch} />;
    case "edit":
      return (
        <View className="gap-1.5">
          <Label>{view.path}</Label>
          <Diff patch={[...view.before.split("\n").map((line) => `-${line}`), ...view.after.split("\n").map((line) => `+${line}`)].join("\n")} />
        </View>
      );
    case "write":
      return (
        <View className="gap-1.5">
          <Label>{view.path}</Label>
          <Mono text={view.content} />
        </View>
      );
    case "search":
      return <Mono tone="text-ink" text={[view.pattern, view.scope, ...view.flags].filter(Boolean).join("  ")} />;
    case "web":
      return <Mono tone="text-ink" text={view.target} />;
    case "prompt":
      return (
        <View className="gap-1.5">
          {view.agent ? <Label>{view.agent}</Label> : null}
          <Text selectable className="text-ink-2">
            {view.text}
          </Text>
        </View>
      );
    case "fields":
      return (
        <View className="gap-2">
          {view.fields.map((field) => (
            <View key={field.key} className="gap-1">
              <Label>{field.key}</Label>
              {field.structured ? <Mono text={field.value} /> : <Text selectable>{field.value}</Text>}
            </View>
          ))}
        </View>
      );
    case "none":
      return null;
  }
});

const OutputPart = memo(function OutputPart({ view }: { view: OutputView }) {
  switch (view.kind) {
    case "code":
      return (
        <View className="gap-1.5">
          {view.path ? <Label>{view.path}</Label> : null}
          <Mono text={view.code} />
        </View>
      );
    case "matches":
      return <Matches groups={view.groups} />;
    case "files":
      return <Mono text={view.paths.join("\n")} />;
    case "changes":
      return <Mono text={view.files.map((file) => `${file.status.padEnd(9)} ${file.path}`).join("\n")} />;
    case "diff":
      return <Diff patch={view.patch} />;
    case "tests":
      return (
        <View className="gap-1.5">
          <Text className={view.tally.failed ? "text-bad" : "text-ok"}>
            {[`${view.tally.passed} passed`, view.tally.failed ? `${view.tally.failed} failed` : "", view.tally.skipped ? `${view.tally.skipped} skipped` : ""].filter(Boolean).join(" · ")}
          </Text>
          <Mono text={view.text} />
        </View>
      );
    case "json":
      return <Mono text={view.json} />;
    case "markdown":
    case "text":
      return <Mono text={view.text} />;
  }
});

/** What came back, as the sheet shows it: a view of the output, and the images the call returned. */
function useOutput(block: ToolBlock | undefined, input: InputView | null) {
  const { output, state } = useToolOutput(block);
  return useMemo(() => {
    const result = output === undefined || output === null ? null : toolResult(output);
    // A successful edit's diff says what happened; "The file has been updated" adds nothing. A failed one says why.
    const quiet = Boolean(block && !block.isError && input && (input.kind === "edit" || input.kind === "write" || input.kind === "patch"));
    const view = block && result && !quiet ? toolOutputView(block, result.text) : null;
    const images = result?.media.flatMap((item) => (item.kind === "image" && item.src && TOOL_IMAGE_URL.test(item.src) ? [item.src] : [])) ?? [];
    return { view, images, state };
  }, [block, input, output, state]);
}

function Heading({ block }: { block: ToolBlock }) {
  const { icon, verb } = toolCallPresentation(block.name, block.input);
  const Icon = toolIcons[icon];
  const state = toolState(block);
  return (
    <View className="flex-row items-center gap-2">
      <Icon size={16} className={block.isError ? "text-bad" : "text-ink-3"} />
      <Text accessibilityRole="header" className="flex-1 text-lg">
        {block.done ? verb : liveVerb(verb)}
      </Text>
      {state === "running" ? <Spinner /> : null}
      {state !== "running" && state !== "success" ? <Text className="text-sm text-bad">{stateLabel(state)}</Text> : null}
    </View>
  );
}

/**
 * One call in full, in a sheet over the thread: what the agent asked for and what came back. It reads the call from
 * the run, so a call still running fills in as it goes; an output the page left out loads from the ledger.
 */
export function ToolSheet() {
  const { runId, id } = useLocalSearchParams<{ runId: string; id: string }>();
  const insets = useSafeAreaInsets();
  const run = useRun(runId);
  const index = run?.blockIndex.get(id);
  const found = index === undefined ? undefined : run?.blocks[index];
  const block = found?.kind === "tool" ? found : undefined;
  const input = useMemo(() => (block ? toolInputView(block) : null), [block]);
  const { view, images, state } = useOutput(block, input);
  const [sheet] = useState(createSheetWindow);
  if (!block || !input) return <View className="flex-1 bg-bg" />;
  const scrolled = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => sheet.scrolled(nativeEvent.contentOffset.y, nativeEvent.layoutMeasurement.height);
  const laidOut = ({ nativeEvent }: LayoutChangeEvent) => sheet.scrolled(sheet.view().top, nativeEvent.layout.height);
  return (
    <SheetWindowContext.Provider value={sheet}>
      <ScrollView className="flex-1 bg-bg" onScroll={scrolled} scrollEventThrottle={16} onLayout={laidOut} onContentSizeChange={sheet.resized}>
        <View ref={sheet.content} className="gap-4 px-5 pt-6" style={{ paddingBottom: insets.bottom + 24 }}>
          <Heading block={block} />
          <InputPart view={input} />
          {state === "loading" ? <Spinner /> : null}
          {state === "failed" ? <Text className="text-ink-4">Could not load the output</Text> : null}
          {images.map((url) => (
            <ImageTile key={url} asset={{ kind: "tool-image", url }} label="Tool image" />
          ))}
          {view ? <OutputPart view={view} /> : null}
          {block.progress ? <Text className="text-ink-3">{block.progress}</Text> : null}
        </View>
      </ScrollView>
    </SheetWindowContext.Provider>
  );
}

import {
  lineCall,
  lineEnd,
  lineWords,
  liveVerb,
  ownToolView,
  shortPath,
  stateLabel,
  testReport,
  toolCallPresentation,
  toolInputView,
  workObjects,
  type ActLine,
  type EditObject,
  type TestsObject,
  type WorkObject,
} from "@openorc/client";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRun } from "../client";
import { cn } from "../ui/cn";
import { Mono } from "../ui/Mono";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { End, Mark } from "./lines";
import { Call, Calls, InputPart, Reading, usePrinted } from "./sheet-call";
import { EditLines, Fetched, GitView, Links, More, Screen, TestsView, Whole } from "./sheet-parts";
import { createSheetWindow, SheetWindowContext, windowScroll } from "./sheet-window";
import { toolIcons, toolState, type ToolBlock } from "./tools";

type Run = NonNullable<ReturnType<typeof useRun>>;

const toolBlocks = (object: WorkObject) => object.blocks.filter((block): block is ToolBlock => block.kind === "tool");

/**
 * The lines the sheet shows, read again from the run's own calls, so one still running fills in as it goes. `calls`
 * names the calls behind them: the one line the reader pressed, or with `whole` every line a claim rests on. A sheet
 * opened on a call alone has no line.
 */
function sheetLines(run: Run | undefined, id: string, calls: string | undefined, whole: boolean): ActLine[] {
  if (!run || !calls) return [];
  const named = new Set(calls.split(","));
  const blocks = run.blocks.filter((block) => named.has(block.id));
  const objects = workObjects(blocks, run.blocks, run.turnOpen);
  const shown = whole ? objects : objects.filter((object) => object.blocks.some((block) => block.id === id)).slice(0, 1);
  return shown.map((object) => ({ object, times: 1, group: [] }));
}

/** Whether the line's name is a message it sent, which the sheet shows whole in its bubble. */
function namesMessage(object: WorkObject): boolean {
  const call = object.kind === "tool" ? lineCall(object) : null;
  return call ? ownToolView(call)?.kind === "sent" : false;
}

/** The line as the sheet's title: its mark, what was done and to what, and how it came out. */
function LineHead({ line }: { line: ActLine }) {
  const words = lineWords(line);
  const title = namesMessage(line.object) ? { verb: null, name: words.verb ?? words.name, code: false } : words;
  return (
    <View className="flex-row items-center gap-2.5">
      <Mark object={line.object} />
      <Text accessibilityRole="header" numberOfLines={2} className={cn("min-w-0 flex-1 text-lg", title.code && "font-mono text-base")}>
        {title.verb ? <Text className={cn("text-lg text-ink-4", title.code && "font-mono text-base")}>{`${title.verb} `}</Text> : null}
        {title.name}
      </Text>
      {/* A test run's results say how it came out, cell by cell. */}
      {line.object.kind === "tests" ? null : <End result={lineEnd(line).result} />}
    </View>
  );
}

function CallHead({ block }: { block: ToolBlock }) {
  const { icon, verb } = toolCallPresentation(block.name, block.input);
  const Icon = toolIcons[icon];
  const state = toolState(block);
  return (
    <View className="flex-row items-center gap-2">
      <Icon size={16} className={block.isError ? "text-bad" : "text-ink-3"} />
      <Text accessibilityRole="header" className="flex-1 text-lg">
        {block.done ? verb : liveVerb(verb)}
      </Text>
      {state === "running" ? <WorkingMark /> : null}
      {state !== "running" && state !== "success" ? <Text className="text-sm text-bad">{stateLabel(state)}</Text> : null}
    </View>
  );
}

/** The command a run was given, as the steps it ran. */
function Command({ call }: { call: ToolBlock }) {
  const input = useMemo(() => toolInputView(call), [call]);
  return input.kind === "command" && input.steps.length ? <InputPart view={input} /> : null;
}

/** A command as it ran: a screen with the last lines it printed, and under it the command. */
function RunBody({ object }: { object: Extract<WorkObject, { kind: "command" }> }) {
  const call = lineCall(object);
  const { text, state } = usePrinted(call ?? undefined);
  if (!call) return null;
  return (
    <>
      <Screen text={text || object.tail.join("\n")} />
      <Reading state={state} />
      <Command call={call} />
    </>
  );
}

/** A test run as its results; its screen only when its output named no file to draw, since the results are that output read. */
function TestsBody({ tests }: { tests: TestsObject }) {
  const call = toolBlocks(tests).at(-1);
  const { text, state } = usePrinted(call);
  const files = useMemo(() => testReport(text), [text]);
  return (
    <>
      <TestsView tests={tests} files={files} />
      <Reading state={state} />
      {files.length ? (
        <Whole label="Whole output">
          <Mono text={text} />
        </Whole>
      ) : (
        <Screen text={text} />
      )}
      {call ? <Command call={call} /> : null}
    </>
  );
}

/** An edit as a few of the lines it took out and put in; the whole change is one press away. One that failed shows the call, which says why. */
function EditBody({ edit }: { edit: EditObject }) {
  const [whole, setWhole] = useState(false);
  if (whole || !edit.lines.length || edit.state === "failed") return <Calls blocks={toolBlocks(edit)} />;
  return (
    <View className="gap-2">
      {edit.chip.path ? (
        // A long way to the file keeps its end, where the file is.
        <Text numberOfLines={1} ellipsizeMode="head" className="text-xs text-ink-4">
          {shortPath(edit.chip.path)}
        </Text>
      ) : null}
      <EditLines lines={edit.lines} />
      <More label="Whole change" onPress={() => setWhole(true)} />
    </View>
  );
}

/** What the line did, drawn as the thing it is. */
function LineBody({ object }: { object: WorkObject }) {
  switch (object.kind) {
    case "command":
      return <RunBody object={object} />;
    case "tests":
      return <TestsBody tests={object} />;
    case "edit":
      return <EditBody edit={object} />;
    case "web":
      return object.links.length ? <Links web={object} /> : <Calls blocks={toolBlocks(object)} />;
    case "fetch":
      return <Fetched fetch={object} />;
    case "git":
      return (
        <>
          <GitView git={object} />
          <Calls blocks={toolBlocks(object)} />
        </>
      );
    case "read":
    case "search":
    case "tool":
      return <Calls blocks={toolBlocks(object)} />;
  }
}

/**
 * What a line of the work did, in a sheet over the thread, drawn as the thing it is: an edit as its lines, a command
 * as its screen, a test run as its results, one of OpenOrc's own tools as what it was about. It reads the calls from
 * the run, so one still running fills in as it goes. Opened from a claim in the reply, it shows everything the claim
 * rests on. Opened on a call alone, it shows that call in full.
 */
export function ToolSheet() {
  const { runId, id, calls, proof } = useLocalSearchParams<{ runId: string; id: string; calls?: string; proof?: string }>();
  const insets = useSafeAreaInsets();
  const run = useRun(runId);
  const lines = useMemo(() => sheetLines(run, id, calls, Boolean(proof)), [run, id, calls, proof]);
  const index = run?.blockIndex.get(id);
  const found = index === undefined ? undefined : run?.blocks[index];
  const block = found?.kind === "tool" ? found : undefined;
  const [sheet] = useState(createSheetWindow);
  if (!lines.length && !block) return <View className="flex-1 bg-bg" />;
  return (
    <SheetWindowContext.Provider value={sheet}>
      <ScrollView className="flex-1 bg-bg" {...windowScroll(sheet)} onAccessibilityEscape={() => router.back()}>
        <View ref={sheet.content} className="gap-8 px-5 pt-6" style={{ paddingBottom: insets.bottom + 24 }}>
          {lines.map((line) => (
            <View key={line.object.id} className="gap-4">
              <LineHead line={line} />
              <LineBody object={line.object} />
            </View>
          ))}
          {lines.length ? null : (
            <View className="gap-4">
              <CallHead block={block!} />
              <Call block={block!} />
            </View>
          )}
        </View>
      </ScrollView>
    </SheetWindowContext.Provider>
  );
}

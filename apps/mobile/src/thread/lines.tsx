import { actLines, lineCall, lineEnd, lineMark, lineState, lineWords, workObjects, type ActLine, type LineMark, type LineResult, type WorkChip, type WorkObject } from "@openorc/client";
import { memo, useMemo, type ComponentType } from "react";
import { View } from "react-native";
import { Brain, FileText, Folder, GitBranch, Globe, Hammer, Search, Terminal, WorkDelegate } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { useOpen } from "./disclosure";
import { openLine } from "./open-sheet";
import { PlainToolRow, toolIcons, type ToolBlock } from "./tools";
import { TranscriptPressable } from "./TranscriptPressable";

const chipIcons: Record<WorkChip["kind"], ComponentType<IconProps>> = {
  file: FileText,
  edit: FileText,
  folder: Folder,
  query: Search,
  command: Terminal,
  intent: Terminal,
  web: Globe,
  tool: Hammer,
  agent: WorkDelegate,
  memory: Brain,
};
const markIcons = { git: GitBranch, run: Terminal, unnamed: FileText };

/** The mark at a line's start: what kind of thing it is, as the desktop's line shows. */
export function Mark({ object }: { object: WorkObject }) {
  const Icon = markIcon(lineMark(object));
  return <Icon size={16} className="text-ink-4" />;
}

function markIcon(mark: LineMark): ComponentType<IconProps> {
  if (mark.kind === "chip") return chipIcons[mark.chip.kind];
  return mark.kind === "tool" ? toolIcons[mark.icon] : markIcons[mark.kind];
}

/** How a line came out, at its end: still going, an edit's size, or a few words. */
export function End({ result }: { result: LineResult }) {
  if (!result) return null;
  if (result.kind === "running")
    return (
      <>
        {result.since ? <Text className="text-xs text-ink-4 tabular-nums">{result.since}</Text> : null}
        <Spinner size={14} />
      </>
    );
  if (result.kind === "words") return <Text className={cn("text-xs tabular-nums", result.bad ? "text-bad" : "text-ink-4")}>{result.text}</Text>;
  return (
    <>
      {result.created ? <Text className="text-xs text-ink-4">New</Text> : null}
      {result.added ? <Text className="text-xs text-ok tabular-nums">+{result.added}</Text> : null}
      {result.removed ? <Text className="text-xs text-bad tabular-nums">−{result.removed}</Text> : null}
    </>
  );
}

/**
 * One thing a step did, on its own line: its mark, what was done and to what, and how it came out. Tapping it opens
 * the thing in the sheet, drawn as what it is. A line that folds several, such as searches done back to back, opens
 * to a line each in place.
 */
export const LineRow = memo(function LineRow({ line, runId }: { line: ActLine; runId: string }) {
  const words = lineWords(line);
  const end = lineEnd(line);
  const folds = line.group.length > 0;
  const [open, setOpen] = useOpen(`line:${line.object.id}`, false);
  const running = lineState(line) === "running";
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityLabel={[words.verb, words.name].filter(Boolean).join(" ")}
        accessibilityState={folds ? { expanded: open } : undefined}
        disabled={!folds && !lineCall(line.object)}
        onPress={() => (folds ? setOpen(!open) : openLine(line, runId))}
        className="-mx-2 min-h-control-row flex-row items-center gap-2.5 rounded-xl px-2 active:bg-surface-2"
      >
        <Mark object={line.object} />
        <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-ink-2", running && "text-ink", words.code && "font-mono text-xs")}>
          {words.verb ? <Text className="text-ink-4">{`${words.verb} `}</Text> : null}
          {words.name}
        </Text>
        {end.times ? <Text className="text-xs text-ink-4 tabular-nums">{end.times}</Text> : null}
        <End result={end.result} />
      </TranscriptPressable>
      {folds && open ? (
        <View className="pl-6.5">
          {line.group.map((each) => (
            <LineRow key={each.object.id} line={each} runId={runId} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

/** A call outside a step: the same lines a step draws for it. An agent it started keeps its one row, which opens that agent's thread. */
export const ToolRow = memo(function ToolRow({ block, runId }: { block: ToolBlock; runId: string }) {
  const lines = useMemo(() => actLines(workObjects([block], [block], !block.done)), [block]);
  if (block.subagent) return <PlainToolRow block={block} runId={runId} />;
  return (
    <View>
      {lines.map((line) => (
        <LineRow key={line.object.id} line={line} runId={runId} />
      ))}
    </View>
  );
});

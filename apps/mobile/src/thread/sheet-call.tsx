import { ownToolView, toolCallPresentation, toolInputView, toolOutputView, toolResult, type InputView, type OutputView } from "@openorc/client";
import { TOOL_IMAGE_URL } from "@openorc/protocol";
import { memo, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { call, useLinkRead } from "../client";
import type { LinkRead } from "../connection/link-hooks";
import { ChevronDown, ChevronRight } from "../generated/icons";
import { Mono } from "../ui/Mono";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { ImageTile } from "./images";
import { matchLines } from "./mono-lines";
import { Outline, OwnView } from "./sheet-own";
import type { ToolBlock } from "./tools";
import { TranscriptPressable } from "./TranscriptPressable";

/** Reads a call's output from the Mac's ledger; `key` names the run and the call. */
const readToolOutput = (key: string) => call("events.toolOutput", JSON.parse(key) as { runId: string; toolCallId: string });

/** A page leaves large outputs out; the sheet reads the call's output from the ledger when it opens. */
export function useToolOutput(block: ToolBlock | undefined): { output: unknown; state: LinkRead<unknown>["state"] } {
  const omitted = block?.outputOmitted && block.runId ? JSON.stringify({ runId: block.runId, toolCallId: block.id }) : null;
  const read = useLinkRead(omitted, readToolOutput);
  if (!omitted) return { output: block?.output, state: "ready" };
  return { output: read.state === "ready" ? (read.value.output ?? undefined) : undefined, state: read.state };
}

/** Everything a call printed, as text, once it is here. */
export function usePrinted(block: ToolBlock | undefined): { text: string; state: LinkRead<unknown>["state"] } {
  const { output, state } = useToolOutput(block);
  return useMemo(() => ({ text: output === undefined || output === null ? "" : toolResult(output).text, state }), [output, state]);
}

/** Where an output the page left out stands while it is read from the Mac. */
export function Reading({ state }: { state: LinkRead<unknown>["state"] }) {
  if (state === "loading") return <Spinner />;
  return state === "failed" ? <Text className="text-ink-4">Could not load the output</Text> : null;
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

export const InputPart = memo(function InputPart({ view }: { view: InputView }) {
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
              <Label>{field.label}</Label>
              {field.structured ? <Mono text={field.value} /> : <Text selectable>{field.value}</Text>}
            </View>
          ))}
        </View>
      );
    case "none":
      return null;
  }
});

function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Data a call gave back, read as an outline; as written when it does not parse. */
function Data({ json }: { json: string }) {
  const value = useMemo(() => parsed(json), [json]);
  return value === undefined ? <Mono text={json} /> : <Outline value={value} />;
}

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
      return <Data json={view.json} />;
    case "markdown":
    case "text":
      return <Mono text={view.text} />;
  }
});

/** What came back, as the sheet shows it: the thing one of OpenOrc's tools was about, or a view of the output, and the images the call returned. */
function useOutput(block: ToolBlock, input: InputView) {
  const { output, state } = useToolOutput(block);
  return useMemo(() => {
    const result = output === undefined || output === null ? null : toolResult(output);
    // A successful edit's diff says what happened; "The file has been updated" adds nothing. A failed one says why.
    const quiet = !block.isError && (input.kind === "edit" || input.kind === "write" || input.kind === "patch");
    const view = result && !quiet ? toolOutputView(block, result.text) : null;
    const images = result?.media.flatMap((item) => (item.kind === "image" && item.src && TOOL_IMAGE_URL.test(item.src) ? [item.src] : [])) ?? [];
    return { view, own: ownToolView(block, output), images, state };
  }, [block, input, output, state]);
}

/**
 * One call in full: what the agent asked for and what came back. One of OpenOrc's own tools draws as the thing it was
 * about. An output the page left out loads from the ledger.
 */
export function Call({ block }: { block: ToolBlock }) {
  const input = useMemo(() => toolInputView(block), [block]);
  const { view, own, images, state } = useOutput(block, input);
  const pictures = images.map((url) => <ImageTile key={url} asset={{ kind: "tool-image", url }} label="Tool image" />);
  if (own) return <OwnView view={own} images={pictures} />;
  return (
    <>
      <InputPart view={input} />
      <Reading state={state} />
      {pictures}
      {view ? <OutputPart view={view} /> : null}
      {block.progress ? <Text className="text-ink-3">{block.progress}</Text> : null}
    </>
  );
}

/** One of several calls behind a line, folded to what it did until pressed. */
function FoldedCall({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const { verb, object } = toolCallPresentation(block.name, block.input);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View className="gap-3">
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="-mx-2 min-h-touch flex-row items-center gap-2 rounded-xl px-2 active:bg-surface-2"
      >
        <Text numberOfLines={1} className="min-w-0 flex-1 text-ink-2">
          <Text className="text-ink-4">{`${verb} `}</Text>
          {object}
        </Text>
        <Chevron size={14} className="text-ink-4" />
      </TranscriptPressable>
      {open ? <Call block={block} /> : null}
    </View>
  );
}

/** The calls behind a line: one in full, several each folded to what it did. */
export function Calls({ blocks }: { blocks: ToolBlock[] }) {
  if (blocks.length === 1) return <Call block={blocks[0]!} />;
  return (
    <View>
      {blocks.map((block) => (
        <FoldedCall key={block.id} block={block} />
      ))}
    </View>
  );
}

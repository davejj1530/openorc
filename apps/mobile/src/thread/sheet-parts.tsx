import { outputLines, shortSha, type EditLine, type FetchObject, type GitObject, type OutputLine, type TestCaseFailure, type TestFile, type TestsObject, type WebObject } from "@openorc/client";
import { useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { Check, GitCommitHorizontal, GitPullRequest, Globe, Minus, Upload, X } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { Mono } from "../ui/Mono";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { TranscriptPressable } from "./TranscriptPressable";

export const Quiet = ({ children, bad = false }: { children: ReactNode; bad?: boolean }) => <Text className={cn("text-xs", bad ? "text-bad" : "text-ink-4")}>{children}</Text>;

/** A press that asks for the rest: more rows, words in full, the whole of an output. */
export function More({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TranscriptPressable accessibilityRole="button" onPress={onPress} className="min-h-touch justify-center self-start active:opacity-60">
      <Text className="text-xs text-ink-3">{label}</Text>
    </TranscriptPressable>
  );
}

/** Something kept behind a press until asked for, such as the whole of an output its results already read. */
export function Whole({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? children : <More label={label} onPress={() => setOpen(true)} />;
}

/** Lines of output a command's screen shows before the rest wait behind a count. */
const SCREEN = 12;
/** Past this many cases a cell is too thin to see. */
const MAX_CELLS = 40;
/** A line of the screen in its tone: a pass in green, a failure in red. */
const TONES = { ok: "text-ok", bad: "text-bad" };

/** A few of the lines an edit took out and put in, each on its own soft ground. */
export function EditLines({ lines }: { lines: EditLine[] }) {
  return (
    <View className="gap-0.5">
      {lines.map((line, index) => (
        <View key={index} className={cn("rounded-sm px-2", line.sign === "+" ? "bg-ok-soft" : "bg-bad-soft")}>
          <Text numberOfLines={1} className={cn("font-mono text-xs leading-5", line.sign === "+" ? "text-ink-2" : "text-ink-3")}>
            {`${line.sign === "+" ? "+" : "−"} ${line.text}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

const tone = (line: OutputLine) => (line.tone ? TONES[line.tone] : "text-ink-2");

/**
 * The last lines a command printed, on a small screen. Asking for the earlier lines trades the screen for everything
 * it printed. A screen with nothing on it draws nothing.
 */
export function Screen({ text }: { text: string }) {
  const [whole, setWhole] = useState(false);
  const output = outputLines(text, SCREEN);
  if (!output.lines.length) return null;
  if (whole) return <Mono text={text} />;
  return (
    <View className="gap-0.5 rounded-xl bg-surface-2 px-4 py-3">
      {output.hidden ? (
        <TranscriptPressable accessibilityRole="button" onPress={() => setWhole(true)} className="pb-1 active:opacity-60">
          <Text className="font-mono text-xs leading-5 text-ink-4">
            {output.hidden} earlier {output.hidden === 1 ? "line" : "lines"}
          </Text>
        </TranscriptPressable>
      ) : null}
      {output.lines.map((line, index) => (
        <Text key={index} numberOfLines={1} className={cn("font-mono text-xs leading-5", tone(line))}>
          {line.text || " "}
        </Text>
      ))}
    </View>
  );
}

function duration(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

const counted = (count: number, word: string) => (count ? `${count} ${word}` : "");

/** A run's count in words, failures first, and a cell per case when there are few enough to see. */
function Count({ tests }: { tests: TestsObject }) {
  const run = tests.run;
  if (!run || run.passed + run.failed + run.skipped === 0) return <Text className="text-ink-2">{tests.chip.label}</Text>;
  const cells = [...Array<string>(run.passed).fill("bg-ok"), ...Array<string>(run.failed).fill("bg-bad"), ...Array<string>(run.skipped).fill("bg-ink-4")];
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {run.failed ? <Text className="text-bad">{run.failed} failed</Text> : null}
      <Text className={run.failed ? "text-ink-3" : "text-ink"}>{run.passed} passed</Text>
      {run.skipped ? <Text className="text-ink-3">{run.skipped} skipped</Text> : null}
      {cells.length <= MAX_CELLS ? (
        <View className="flex-row gap-0.5" accessibilityElementsHidden>
          {cells.map((color, index) => (
            <View key={index} className={cn("h-3 w-1 rounded-sm", color)} />
          ))}
        </View>
      ) : null}
      {duration(run.durationMs) ? <Text className="ml-auto text-xs text-ink-4 tabular-nums">{duration(run.durationMs)}</Text> : null}
    </View>
  );
}

const marks = { passed: Check, failed: X, skipped: Minus };
const markTone = { passed: "text-ok", failed: "text-bad", skipped: "text-ink-4" };

/** A case that failed: its name, what went wrong, what was expected and got, then where in the project's own code. */
function FailedCase({ failure }: { failure: TestCaseFailure }) {
  const own = failure.frames.filter((frame) => !frame.library);
  const others = failure.frames.length - own.length;
  return (
    <View className="gap-1 pb-2 pl-5.5">
      <Text className="text-ink">{failure.name}</Text>
      {failure.message ? (
        <Text selectable className="font-mono text-xs leading-5 text-bad">
          {failure.message}
        </Text>
      ) : null}
      {failure.detail.length ? (
        <View className="rounded-xl bg-surface-2 px-3 py-2">
          <Text selectable className="font-mono text-xs leading-5 text-ink-2">
            {failure.detail.join("\n")}
          </Text>
        </View>
      ) : null}
      {own.map((frame, index) => (
        <Text key={index} selectable className="font-mono text-xs leading-5 text-ink-2">{`${frame.path}:${frame.line}`}</Text>
      ))}
      {others ? <Text className="text-xs text-ink-4">{`${others} library ${others === 1 ? "frame" : "frames"}`}</Text> : null}
    </View>
  );
}

function FileRow({ file }: { file: TestFile }) {
  const Mark = marks[file.state];
  const name = file.path.split(/[\\/]/).at(-1) ?? file.path;
  const counts = [counted(file.failed, "failed"), counted(file.passed, "passed"), counted(file.skipped, "skipped")].filter(Boolean).join(" · ");
  return (
    <View>
      <View className="min-h-control-row flex-row items-center gap-2">
        <Mark size={14} className={markTone[file.state]} />
        <Text numberOfLines={1} className="min-w-0 flex-shrink text-ink">
          {name}
        </Text>
        <Text numberOfLines={1} className="ml-auto text-xs text-ink-4 tabular-nums">
          {[counts, duration(file.ms)].filter(Boolean).join("  ")}
        </Text>
      </View>
      {file.failures.map((failure, index) => (
        <FailedCase key={`${index}:${failure.name}`} failure={failure} />
      ))}
    </View>
  );
}

/** Files a run lists before the rest wait behind a count. */
const FILES = 8;

/**
 * A test run: its count and cells, then the files it ran, failed ones first, each failed case under its file with
 * what went wrong and where. A run whose output named no file shows the first failures it named.
 */
export function TestsView({ tests, files }: { tests: TestsObject; files: TestFile[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES);
  const named = files.length ? [] : (tests.run?.failures ?? []).slice(0, 3);
  return (
    <View className="gap-2">
      <Count tests={tests} />
      {shown.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
      {files.length > shown.length ? <More label={`${files.length - shown.length} more files`} onPress={() => setAll(true)} /> : null}
      {named.map((failure, index) => (
        <View key={index} className="gap-1">
          <Text className="text-ink">{failure.name}</Text>
          {failure.message ? <Text className="font-mono text-xs leading-5 text-bad">{failure.message}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** A row that leads somewhere on the web: a mark, a name and the quiet words under it. */
function LinkRow({ icon: Icon, name, note, url }: { icon: ComponentType<IconProps>; name: string; note: string; url: string | null }) {
  return (
    <TranscriptPressable
      accessibilityRole={url ? "link" : undefined}
      disabled={!url}
      onPress={() => url && openInApp(url)}
      className="-mx-2 min-h-touch flex-row items-center gap-2.5 rounded-xl px-2 py-1.5 active:bg-surface-2"
    >
      <Icon size={16} className="text-ink-4" />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1}>{name}</Text>
        {note ? (
          <Text numberOfLines={1} className="text-xs text-ink-4">
            {note}
          </Text>
        ) : null}
      </View>
    </TranscriptPressable>
  );
}

const host = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0] ?? url;

/** The pages a web search found, each a way to its page. */
export function Links({ web }: { web: WebObject }) {
  return (
    <View>
      {web.links.map((link) => (
        <LinkRow key={link.url} icon={Globe} name={link.title || host(link.url)} note={host(link.url)} url={link.url} />
      ))}
    </View>
  );
}

/** A page that was read: its address, and the first of what it said. */
export function Fetched({ fetch }: { fetch: FetchObject }) {
  return (
    <View className="gap-2">
      <LinkRow icon={Globe} name={host(fetch.url)} note={fetch.url.replace(/^https?:\/\//, "")} url={fetch.url} />
      {fetch.excerpt ? (
        <Text selectable className="text-ink-2">
          {fetch.excerpt}
        </Text>
      ) : null}
    </View>
  );
}

/** What a step did with Git: the commits it made, where it pushed them, and the pull request it opened. */
export function GitView({ git }: { git: GitObject }) {
  const { push, pullRequest } = git;
  return (
    <View>
      {git.commits.map((commit) => (
        <LinkRow key={commit.sha} icon={GitCommitHorizontal} name={commit.subject} note={shortSha(commit.sha)} url={null} />
      ))}
      {push ? <LinkRow icon={Upload} name={push.state === "failed" ? `Push to ${push.remote} failed` : `Pushed to ${push.remote}`} note={git.branch ?? ""} url={null} /> : null}
      {pullRequest ? <LinkRow icon={GitPullRequest} name={pullRequest.title ?? "Pull request"} note={pullRequest.number === null ? "" : `#${pullRequest.number}`} url={pullRequest.url} /> : null}
    </View>
  );
}

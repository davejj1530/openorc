import { fileMarks, relativeTime, shortSha, type FileMarkTone } from "@openorc/client";
import type { Commit, FileChangeStat } from "@openorc/protocol";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import { countsText, fileTrailing, type LineCounts } from "./change-words";

const tones: Record<FileMarkTone, string> = { ok: "text-ok", "ink-2": "text-ink-2", bad: "text-bad", warn: "text-warn" };
const statusWords: Record<FileChangeStat["status"], string> = { added: "Added", untracked: "New", modified: "Modified", deleted: "Deleted", renamed: "Renamed" };

/** "+12 −3" in ok and bad, a side only when it has lines. */
export function LineCountsText({ counts }: { counts: LineCounts }) {
  return (
    <View className="flex-row gap-1.5">
      {counts.insertions ? <Text className="text-sm tabular-nums text-ok">{counts.insertions}</Text> : null}
      {counts.deletions ? <Text className="text-sm tabular-nums text-bad">{counts.deletions}</Text> : null}
    </View>
  );
}

/** One changed file on one line: its status letter, its path cut at the front so the name always shows, and its counts. */
export const FileRow = memo(function FileRow({ file, onOpen }: { file: FileChangeStat; onOpen: (path: string) => void }) {
  const mark = fileMarks[file.status];
  const trailing = fileTrailing(file.body);
  const spoken = trailing?.kind === "stat" ? countsText(trailing) : trailing?.text;
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[file.path, statusWords[file.status], spoken].filter(Boolean).join(", ")}
      onPress={() => onOpen(file.path)}
      className="h-touch flex-row items-center gap-3 px-5 active:bg-surface-2"
    >
      <Text className={cn("w-2.5 font-mono text-xs", tones[mark.tone])}>{mark.letter}</Text>
      <Text numberOfLines={1} ellipsizeMode="head" className="min-w-0 flex-1 font-mono text-xs text-ink-2">
        {file.path}
      </Text>
      {trailing?.kind === "stat" ? <LineCountsText counts={trailing} /> : null}
      {trailing?.kind === "word" ? <Text className="text-sm text-ink-4">{trailing.text}</Text> : null}
    </ListPressable>
  );
});

/** The files past the list's cap, counted; it does not press. */
export function UnlistedRow({ text }: { text: string }) {
  return (
    <View className="h-touch justify-center px-5">
      <Text className="text-sm text-ink-4">{text}</Text>
    </View>
  );
}

export function CommitsHead({ text }: { text: string }) {
  return (
    <View className="h-touch justify-end px-5 pb-2">
      <Text accessibilityRole="header" numberOfLines={1} className="text-sm text-ink-4">
        {text}
      </Text>
    </View>
  );
}

/** A commit: its subject, then its short sha and when, with "Not pushed" while origin lacks it. */
export const CommitRow = memo(function CommitRow({ commit, unpushed }: { commit: Commit; unpushed: boolean }) {
  return (
    <View accessible accessibilityLabel={[commit.subject, unpushed ? "Not pushed" : null, relativeTime(commit.at)].filter(Boolean).join(", ")} className="h-15 justify-center gap-1 px-5">
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="min-w-0 flex-1">
          {commit.subject}
        </Text>
        {unpushed ? (
          <View className="h-badge justify-center rounded-full bg-surface-2 px-2">
            <Text className="text-xs text-ink-3">Not pushed</Text>
          </View>
        ) : null}
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="font-mono text-xs text-ink-4">{shortSha(commit.sha)}</Text>
        <Text className="text-xs tabular-nums text-ink-4">{relativeTime(commit.at)}</Text>
      </View>
    </View>
  );
});

/** Nothing to show: the desktop's empty words, over the Commits section. */
export function CleanBlock({ where }: { where: string }) {
  return (
    <View className="items-center gap-1 px-8 py-10">
      <Text className="text-md">Clean workspace</Text>
      <Text className="text-center text-sm text-ink-4">Edits the agent makes in {where} show up here, ready to commit.</Text>
    </View>
  );
}

/** The Mac could not list the changes: what it said, and a way to ask again. */
export function FailedBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-1 px-8">
      <Text className="text-md">Could not read the workspace</Text>
      <Text className="text-center text-sm text-ink-4">{message}</Text>
      <Pressable accessibilityRole="button" onPress={onRetry} className="min-h-touch justify-center rounded-full px-4 active:bg-surface-2">
        <Text className="text-ink-2">Retry</Text>
      </Pressable>
    </View>
  );
}

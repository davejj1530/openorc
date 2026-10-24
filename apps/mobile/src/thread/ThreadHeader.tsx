import { snoozeWakeLabel, threadMark } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { Pressable } from "react-native";
import { useLinkState, useRpc } from "../client";
import { useLinkWords } from "../connection/use-link-words";
import { Text } from "../ui/Text";

const pullWords = { open: "PR open", merged: "PR merged", closed: "PR closed" } as const;

/**
 * The header's faint line: where the thread lives, its pull request, when a snooze ends and what it is doing when that
 * is worth saying. While the phone is not connected, the connection's state takes the line instead.
 */
export function statusLine(thread: ThreadSummary, project: string | undefined, now = Date.now()): string {
  const mark = threadMark(thread);
  const doing = mark && (mark.kind === "running" || mark.kind === "waiting" || mark.kind === "failed") ? mark.label : null;
  const pull = thread.prUrl ? pullWords[thread.prState ?? "open"] : null;
  const snoozed = thread.snoozedUntil && thread.snoozedUntil > now ? `Snoozed until ${snoozeWakeLabel(thread.snoozedUntil)}` : null;
  return [thread.projectId === WORKSPACE_ID ? "Workspace" : project, pull, snoozed, doing].filter(Boolean).join(" · ");
}

/** The thread's title over a faint line of where it lives and what it is doing, or how the link is. Tapping the title renames it. */
export function ThreadTitle({ thread, onRename }: { thread: ThreadSummary | null; onRename: () => void }) {
  const projects = useRpc("projects.list", {});
  const link = useLinkWords(useLinkState());
  const project = projects.data?.find((item) => item.id === thread?.projectId)?.name;
  if (!thread) return null;
  const line = link.tone !== "ok" && link.status ? link.status : statusLine(thread, project);
  return (
    <Pressable accessibilityRole="header" accessibilityLabel={[thread.title, line].filter(Boolean).join(", ")} onPress={onRename} className="max-w-60 items-center active:opacity-60">
      <Text numberOfLines={1} className="text-md leading-5">
        {thread.title}
      </Text>
      {line ? (
        <Text numberOfLines={1} className="text-xs leading-4 text-ink-4">
          {line}
        </Text>
      ) : null}
    </Pressable>
  );
}

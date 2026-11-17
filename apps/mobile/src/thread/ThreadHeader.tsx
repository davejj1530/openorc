import { snoozeWakeLabel, threadMark, togetherActivity } from "@openorc/client";
import { isSubagentThread, placeOf, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { useOwnCloud } from "../cloud/use-own-cloud";
import { useLinkState, useRpc } from "../client";
import { useLinkWords } from "../connection/use-link-words";
import { Text } from "../ui/Text";

const pullWords = { open: "PR open", merged: "PR merged", closed: "PR closed" } as const;

/**
 * The header's faint line, in two parts: where the thread lives (its project, its pull request, when a snooze ends) and
 * what it is doing when that is worth saying, which is never cut short. An OpenOrc Cloud thread says whose turn or ask
 * it is when a teammate is in it, as the Mac's header does; it names OpenOrc Cloud only while it says no state.
 */
export function statusParts(thread: ThreadSummary, project: string | undefined, now = Date.now()): { where: string; state: string | null } {
  const mark = threadMark(thread);
  const doing = mark && (mark.kind === "running" || mark.kind === "waiting" || mark.kind === "waiting-other" || mark.kind === "failed") ? mark.label : null;
  const pull = thread.prUrl ? pullWords[thread.prState ?? "open"] : null;
  const snoozed = thread.snoozedUntil && thread.snoozedUntil > now ? `Snoozed until ${snoozeWakeLabel(thread.snoozedUntil)}` : null;
  const place = placeOf(thread);
  if (place.elsewhere) {
    const state = togetherActivity(thread)?.text ?? doing;
    return { where: [project ?? thread.owner?.project?.name, state ? null : place.mark, pull].filter(Boolean).join(" · "), state };
  }
  return { where: [thread.projectId === WORKSPACE_ID ? "Workspace" : project, pull, snoozed].filter(Boolean).join(" · "), state: doing };
}

/** The header's faint line as one string, for VoiceOver. */
export function statusLine(thread: ThreadSummary, project: string | undefined, now = Date.now()): string {
  const { where, state } = statusParts(thread, project, now);
  return [where, state].filter(Boolean).join(" · ");
}

/** Where on the left, shortened first; the state after it, always whole. */
function StatusParts({ where, state }: { where: string; state: string | null }) {
  return (
    <View className="flex-row">
      {where ? (
        <Text numberOfLines={1} className="shrink text-xs leading-4 text-ink-4">
          {state ? `${where} · ` : where}
        </Text>
      ) : null}
      {state ? <Text className="shrink-0 text-xs leading-4 text-ink-4">{state}</Text> : null}
    </View>
  );
}

/**
 * The link's words under a thread's title while the Mac's link is in trouble; none for a cloud thread the phone reaches
 * through its own session, which the Mac's link says nothing of.
 */
export function threadLinkLine(link: { tone: string; status: string | null }, thread: Pick<ThreadSummary, "owner">, ownCloud: boolean): string | null {
  if (ownCloud && thread.owner?.brain === "hosted") return null;
  return link.tone !== "ok" && link.status ? link.status : null;
}

/** The thread's title over a faint line of where it lives and what it is doing, or how the link is. Tapping the title renames it. */
export function ThreadTitle({ thread, onRename }: { thread: ThreadSummary | null; onRename: () => void }) {
  const projects = useRpc("projects.list", {});
  const parentId = isSubagentThread(thread) ? thread?.parentThreadId : null;
  const parent = useRpc("threads.get", { id: parentId ?? "" }, { enabled: Boolean(parentId) });
  const link = useLinkWords(useLinkState());
  const ownCloud = useOwnCloud();
  const project = projects.data?.find((item) => item.id === thread?.projectId)?.name;
  if (!thread) return null;
  const parts = statusParts(thread, project);
  const place = parentId ? parent.data?.title : statusLine(thread, project);
  const linkLine = threadLinkLine(link, thread, ownCloud);
  const line = linkLine ?? place;
  // A cloud thread's title is everyone's in its project; a phone does not change it yet.
  const rename = isSubagentThread(thread) || placeOf(thread).elsewhere ? undefined : onRename;
  const open = parentId ? () => router.push({ pathname: "/thread/[id]", params: { id: parentId } }) : rename;
  const label = [thread.title, line].filter(Boolean).join(", ");
  const lines = (
    <>
      <Text numberOfLines={1} className="text-md leading-5">
        {thread.title}
      </Text>
      {linkLine || parentId ? (
        <Text numberOfLines={1} className="text-xs leading-4 text-ink-4">
          {line}
        </Text>
      ) : (
        <StatusParts {...parts} />
      )}
    </>
  );
  // With nothing to do on a tap it is a plain heading, as a panel's title is.
  if (!open)
    return (
      <View accessible accessibilityRole="header" accessibilityLabel={label} className="max-w-60 items-center">
        {lines}
      </View>
    );
  return (
    <Pressable accessibilityRole="header" accessibilityLabel={label} onPress={open} className="max-w-60 items-center active:opacity-60">
      {lines}
    </Pressable>
  );
}

import { hasUnpushed, type PullRequestStep } from "@openorc/client";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { pushThread } from "./publish-actions";
import { barPills, noticeLine, type BarPill, type Notice } from "./publish-state";
import { publishStore } from "./publishing";
import type { ChangesReads } from "./use-changes";
import type { usePublish } from "./use-publish";

/** A notice shows this many lines; a failure cut there opens its full text from Details. */
const NOTICE_LINES = 3;

/** How many lines `text` takes at the notice's width, read once from a hidden copy laid out without a limit. */
function useLineCount(text: string): { count: number | null; measure: (lines: number) => void } {
  const [measured, setMeasured] = useState<{ text: string; lines: number } | null>(null);
  return { count: measured?.text === text ? measured.lines : null, measure: (lines) => setMeasured({ text, lines }) };
}

/** The notice's words, three lines at most; a failure's full text is a tap away once they are cut. */
export function NoticeText({ notice, threadId }: { notice: Notice; threadId: string }) {
  const lines = useLineCount(notice.text);
  const tone = cn("text-sm text-ink-3", notice.tone === "bad" && "text-bad");
  return (
    <View accessibilityLiveRegion="polite" className="gap-1">
      <Text numberOfLines={NOTICE_LINES} selectable className={tone}>
        {notice.text}
      </Text>
      {notice.details && lines.count === null ? (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="absolute inset-x-0 top-0 opacity-0">
          <Text testID="notice-measure" onTextLayout={({ nativeEvent }) => lines.measure(nativeEvent.lines.length)} className={tone}>
            {notice.text}
          </Text>
        </View>
      ) : null}
      {notice.details && lines.count !== null && lines.count > NOTICE_LINES ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 10, right: 16 }}
          onPress={() => router.push({ pathname: "/details", params: { threadId } })}
          className="self-start active:opacity-60"
        >
          <Text className="text-sm text-ink-2">Details</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A pill of the bar: the next step in ink and flexing, the one after it plain at its own width. A dim one still says why. */
function BarButton({ pill, busy, onPress }: { pill: BarPill; busy: boolean; onPress: () => void }) {
  const dim = Boolean(pill.reason) || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: dim }}
      onPress={onPress}
      className={cn("h-touch items-center justify-center rounded-full px-5", pill.ink ? "flex-1 bg-accent active:opacity-80" : "bg-surface-2 active:bg-surface-3", dim && pill.ink && "bg-surface-3")}
    >
      <Text numberOfLines={1} className={cn("text-md", pill.ink && "text-accent-fg", dim && "text-ink-3", dim && !pill.ink && "text-ink-4")}>
        {pill.label}
      </Text>
    </Pressable>
  );
}

function openPullRequestStep(threadId: string, step: PullRequestStep | null): void {
  if (step?.kind === "open") router.push({ pathname: "/pull-request", params: { threadId } });
  else if (step) openInApp(step.url);
}

/**
 * The Changes screen's pinned foot: one line of notice, and at most two pills, the next step of Commit, Push and PR in
 * ink. It hides when there is nothing to do; a team's thread keeps only its line.
 */
export function PublishBar({ threadId, reads, publish }: { threadId: string; reads: ChangesReads; publish: ReturnType<typeof usePublish> }) {
  const insets = useSafeAreaInsets();
  const { view, publishing, mac } = publish;
  const files = reads.uncommitted.data?.totals.files ?? 0;
  const team = Boolean(reads.thread.data?.teamInstanceId);
  const pills = view && !team ? barPills(view, files) : [];
  const reasons = pills.map((pill) => pill.reason ?? "").join("|");
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => setAsked(null), [reasons]);
  const busy = publishing.kind === "running" || publishing.kind === "lost";
  const notice = noticeLine({ publishing, asked, team, pushBlocked: view?.pushBlocked ?? null, bar: pills.length > 0, unpushed: hasUnpushed(reads.push.data), uncommitted: files, mac });
  if (!pills.length && !notice) return null;
  const press = (pill: BarPill) => {
    if (busy) return;
    if (pill.reason) {
      haptic.warn();
      return setAsked(pill.reason);
    }
    publishStore.clear(threadId);
    if (pill.action === "commit") router.push({ pathname: "/commit", params: { threadId } });
    else if (pill.action === "push") void pushThread(threadId);
    else openPullRequestStep(threadId, view?.pullRequest ?? null);
  };
  return (
    <View className="gap-3 bg-bg px-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
      {notice ? <NoticeText notice={notice} threadId={threadId} /> : null}
      {pills.length ? (
        <View className="flex-row gap-2">
          {pills.map((pill) => (
            <BarButton key={pill.action} pill={pill} busy={busy} onPress={() => press(pill)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

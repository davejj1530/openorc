import { hostedActionLine, hostedPublishReason, panelToolLabels } from "@openorc/client";
import { HOSTED_REASONS, type HostedReviewState, type HostedThreadChanges, type HostedThreadCommits, type ThreadSummary } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { newId, useRpc } from "../client";
import { startCloudReview, useCloudReview } from "../cloud/cloud-review";
import { haptic } from "../ui/haptics";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { changesLine } from "./change-words";
import { CommitRow, CommitsHead, FailedBlock, FileRow, UnlistedRow } from "./ChangeRows";
import { PanelTitle } from "./PanelTitle";
import { BarButton } from "./PublishBar";
import { pullWords, type BarPill } from "./publish-state";

type Review = ReturnType<typeof useCloudReview>;

/** Why Commit cannot go now: the reason everything waits, else changes the server did not record. */
function commitReason(reason: string | null, changes: HostedThreadChanges | undefined): string | null {
  if (reason) return reason;
  return !changes || changes.state === "missing" || (changes.state === "recorded" && changes.missing) ? "The latest changes weren't recorded." : null;
}

/**
 * The bar's pills, in the Mac's bar's words and flow: Commit while there is work to commit; Push, or Publish branch for
 * a branch not on GitHub yet, while there is work to push; and the pull request, opened once it exists, else offered
 * once the branch is on GitHub. At most two, from the first that can go, which is in ink; a pull request that exists
 * stays plain, as it leaves the app.
 */
function cloudPills(thread: ThreadSummary, state: HostedReviewState | undefined, changes: HostedThreadChanges | undefined, reason: string | null, review: Review): BarPill[] {
  const running = (kind: string) => review.pending && review.request?.kind === kind;
  const steps: Omit<BarPill, "ink">[] = [];
  // An action under way keeps its pill, reading that it runs, though the state the server gives may already be past it.
  if (state?.work.uncommitted || running("commit"))
    steps.push({ action: "commit", label: running("commit") ? "Committing…" : "Commit", reason: commitReason(reason, changes), running: running("commit") });
  if (state?.work.unpushed || running("push")) {
    const words = state?.work.published ? { idle: "Push", running: "Pushing…" } : { idle: "Publish branch", running: "Publishing…" };
    steps.push({ action: "push", label: running("push") ? words.running : words.idle, reason, running: running("push") });
  }
  const existing = state?.pullRequest ?? (thread.prUrl && thread.prState ? { url: thread.prUrl, state: thread.prState } : null);
  const published = Boolean(state?.work.published && !state.work.unpushed && state.branch !== state.baseBranch);
  if (existing) steps.push({ action: "pr", label: pullWords[existing.state], reason: null, running: false });
  else if (published || running("pull_request")) steps.push({ action: "pr", label: running("pull_request") ? "Opening…" : "PR", reason, running: running("pull_request") });
  const inked = steps.findIndex((step) => !step.reason && !(step.action === "pr" && existing));
  const first = Math.max(0, inked);
  return steps.slice(first, first + 2).map((step, index) => ({ ...step, ink: index === 0 && inked >= 0 }));
}

/** The line over the pills: a failure to reach the server, the server's refusal, else how the latest action stands. */
function noticeOf(review: Review, state: HostedReviewState | undefined): { text: string; bad: boolean } | null {
  const elsewhere = state?.actions.find((item) => item.id !== review.request?.id);
  const observed = review.result ?? elsewhere;
  const text = review.error ?? review.refusal ?? (observed ? hostedActionLine(observed) : null);
  if (!text) return null;
  return { text, bad: Boolean(review.error || review.refusal || observed?.state === "failed" || observed?.state === "refused") };
}

/** The screen's pinned foot: the latest action's line, and Commit, Push and the pull request. A dim pill says why when tapped. */
function CloudPublishBar({ thread, state, changes, stateError }: { thread: ThreadSummary; state: HostedReviewState | undefined; changes: HostedThreadChanges | undefined; stateError: Error | null }) {
  const insets = useSafeAreaInsets();
  const review = useCloudReview(thread.id, thread.owner?.reach === "live");
  const [asked, setAsked] = useState<string | null>(null);
  const reason = (review.pending ? "Wait for the current action to finish." : null) ?? stateError?.message ?? hostedPublishReason(thread, state);
  const pills = cloudPills(thread, state, changes, reason, review);
  const notice = noticeOf(review, state);
  const url = state?.pullRequest?.url ?? thread.prUrl;
  if (!pills.length && !notice) return null;
  const press = (pill: BarPill) => {
    if (pill.reason) {
      haptic.warn();
      return setAsked(pill.reason);
    }
    setAsked(null);
    if (pill.action === "commit") router.push({ pathname: "/cloud-commit", params: { threadId: thread.id } });
    else if (pill.action === "push") startCloudReview(thread.id, { kind: "push", id: newId() });
    else if (url) openInApp(url);
    else router.push({ pathname: "/cloud-pull-request", params: { threadId: thread.id } });
  };
  return (
    <View className="gap-3 bg-bg px-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
      {notice ? (
        <View accessibilityLiveRegion="polite" className="gap-1">
          <Text numberOfLines={3} selectable className={notice.bad ? "text-sm text-bad" : "text-sm text-ink-3"}>
            {notice.text}
          </Text>
          {review.error ? (
            <Text accessibilityRole="button" onPress={review.retry} className="self-start text-sm text-ink-2">
              Retry
            </Text>
          ) : null}
        </View>
      ) : null}
      {asked ? <Text className="text-sm text-ink-3">{asked}</Text> : null}
      <View className="flex-row gap-2">
        {pills.map((pill) => (
          <BarButton key={pill.action} pill={pill} busy={pill.running} onPress={() => press(pill)} />
        ))}
      </View>
    </View>
  );
}

/** The thread's commits, newest first, each "Not pushed" until the one GitHub has. */
function Commits({ commits }: { commits: HostedThreadCommits }) {
  const pushedAt = commits.pushed ? commits.commits.findIndex((commit) => commit.sha === commits.pushed) : -1;
  if (!commits.commits.length) return null;
  return (
    <>
      <CommitsHead text="Commits" />
      {commits.commits.map((commit, index) => (
        <CommitRow key={commit.sha} commit={commit} unpushed={pushedAt === -1 ? !commits.pushed : index < pushedAt} />
      ))}
    </>
  );
}

/**
 * Whether the thread's server serves its changes: undefined while it is asked, its reason once it says they are off,
 * and null otherwise. A capability read that fails leaves the change reads to say what is wrong, as on the desktop.
 */
function useChangesOff(threadId: string): string | null | undefined {
  const read = useRpc("hosted.capabilities", { threadId }, { staleTime: 60_000 });
  if (read.error) return null;
  if (!read.data) return undefined;
  const feature = read.data.features.changes;
  return feature?.available ? null : (feature?.reason ?? HOSTED_REASONS.changes);
}

/** What the branch holds: its files since the thread started, or why none are listed. */
function Files({ threadId, changes, error, retry }: { threadId: string; changes: HostedThreadChanges | undefined; error: Error | null; retry: () => void }) {
  if (error) return <FailedBlock message={error.message} onRetry={retry} />;
  if (!changes) return <View className="items-center py-10">{<Spinner />}</View>;
  if (changes.state !== "recorded") return <Text className="px-5 py-10 text-center text-ink-4">{changes.line}</Text>;
  const open = (path: string) => router.push({ pathname: "/cloud-diff", params: { threadId, path } });
  return (
    <>
      {changes.files.map((file) => (
        <FileRow key={file.path} file={file} onOpen={open} />
      ))}
      {changes.unlisted ? <UnlistedRow text={`${changes.unlisted} more not listed`} /> : null}
    </>
  );
}

/**
 * A cloud thread's Changes, as the desktop's cloud panel has them: the branch's files since the thread started, each
 * opening its diff; its commits; and Commit, Push and the pull request, which OpenOrc Cloud carries out on its machine.
 */
export function CloudChangesScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const thread = useRpc("threads.get", { id: threadId });
  const off = useChangesOff(threadId);
  const changes = useRpc("hosted.review.changes", { threadId }, { enabled: off === null });
  const state = useRpc("hosted.review.state", { threadId });
  const commits = useRpc("hosted.review.commits", { threadId }, { enabled: off === null });
  const [footer, setFooter] = useState(0);
  const recorded = changes.data?.state === "recorded" ? changes.data : null;
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={panelToolLabels.changes} line={recorded ? changesLine(recorded.totals) : null} /> }} />
      <ScrollView contentContainerStyle={{ paddingBottom: footer + 12 }}>
        {/* A server that says it does not serve changes is answered by its reason alone: nothing failed to retry. */}
        {off ? <Text className="px-5 py-10 text-center text-ink-4">{off}</Text> : <Files threadId={threadId} changes={changes.data} error={changes.error} retry={() => void changes.refetch()} />}
        {commits.data ? <Commits commits={commits.data} /> : null}
      </ScrollView>
      {thread.data ? (
        <View onLayout={({ nativeEvent }) => setFooter(nativeEvent.layout.height)} className="absolute inset-x-0 bottom-0">
          <CloudPublishBar thread={thread.data} state={state.data} changes={changes.data} stateError={state.error} />
        </View>
      ) : null}
    </View>
  );
}

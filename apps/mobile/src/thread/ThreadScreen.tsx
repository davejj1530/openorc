import type { LegendListRef } from "@legendapp/list/react-native";
import { useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { conversationActivity, conversationSendDisabledReason, processFit, type SubmitRequest } from "@openorc/client";
import type { Run, ThreadSummary } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { client, useLinkState, useRpc } from "../client";
import { linkReason } from "../connection/link-reason";
import { Composer } from "../composer/Composer";
import { useShareSettings } from "../composer/settings-bridge";
import { useCoverHome } from "../home/home-cover";
import { useThreadOnScreen } from "../notifications/on-screen";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { holdTranscriptList, perfEnabled, reportThreadOpened } from "./perf-probe";
import { PerfProbe } from "./PerfProbe";
import { createDisclosure, DisclosureContext } from "./disclosure";
import { useMarkSeen } from "./mark-seen";
import { useSnoozeClock } from "./snooze-clock";
import { threadMenu } from "./thread-actions";
import { ThreadTitle } from "./ThreadHeader";
import { headerMenu } from "./ThreadMenu";
import { usePanelButton } from "./use-panel-button";
import { Transcript } from "./Transcript";
import { useThreadActions } from "./use-thread-actions";
import { VoicesContext, type Voice } from "./voices";
import { useWaitingApprovals } from "./waiting-approvals";

const NO_RUNS: Run[] = [];
const goBack = () => router.back();

/** Each run's agent and model for the turn heads, named as the catalog names the model. */
function useVoices(runs: Run[]): ReadonlyMap<string, Voice> {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  return useMemo(
    () =>
      new Map(runs.map((run) => [run.id, { agent: run.agent, model: run.model ? (models.data?.find((option) => option.agent === run.agent && option.id === run.model)?.label ?? run.model) : null }])),
    [runs, models.data],
  );
}

type Activity = ReturnType<typeof conversationActivity>;
const IDLE: Activity = { live: false, working: false, generatingImage: false };

interface PaneProps {
  threadId: string;
  thread: ThreadSummary | null;
  runs: Run[];
  loading: boolean;
  /** The Mac could not list the thread's runs; `retry` asks again. */
  failed: boolean;
  retry: () => void;
  onActivity: (activity: Activity) => void;
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  followKey: number;
}

/** History that would not load: one quiet line and a way to ask again. */
function LoadFailed({ retry }: { retry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-1">
      <Text className="text-ink-4">Couldn’t load this thread</Text>
      <Pressable accessibilityRole="button" onPress={retry} className="min-h-touch justify-center rounded-full px-4 active:bg-surface-2">
        <Text className="text-ink-2">Retry</Text>
      </Pressable>
    </View>
  );
}

/**
 * The conversation itself, and the only part of the screen that hears every streamed frame: the header and the
 * composer hear only when the conversation starts or stops being busy.
 */
function TranscriptPane({ threadId, thread, runs, loading, failed, retry, onActivity, composerInset, listRef, followKey }: PaneProps) {
  const { merged, liveTranscript, hasOlder, loadOlder, shown } = client.useConversationTranscript({ runs, threadId });
  const waiting = useWaitingApprovals(threadId, shown);
  const { live, working, generatingImage } = conversationActivity({ thread, activeRun: runs.at(-1), liveTranscript, compacting: false });
  useEffect(() => onActivity({ live, working, generatingImage }), [live, working, generatingImage, onActivity]);
  const [following, setFollowing] = useState(true);
  const blocks = merged?.blocks;
  useEffect(() => {
    if (blocks?.length) reportThreadOpened(threadId, blocks.length);
  }, [threadId, blocks?.length]);
  if (failed && !blocks?.length) return <LoadFailed retry={retry} />;
  if (!merged || !blocks?.length) return <View className="flex-1 items-center justify-center">{loading || runs.length ? <Spinner /> : <Text className="text-ink-4">Nothing yet</Text>}</View>;
  return (
    <Transcript
      blocks={blocks}
      live={Boolean(working || merged.turnOpen)}
      working={working}
      runId={merged.runId}
      hasOlder={hasOlder}
      loadOlder={loadOlder}
      filled={merged.hydrated}
      composerInset={composerInset}
      listRef={listRef}
      following={following}
      onFollow={setFollowing}
      followKey={followKey}
      waiting={waiting}
    />
  );
}

/**
 * A thread on the phone: its conversation at phone size, from the newest turn back a page at a time, with the composer
 * pinned above the keyboard. The send tree, the paging and the settings are the desktop's, from @openorc/client. The
 * header's More menu organizes the thread; marking it unread goes back to Home, since reading it here would mark it
 * read again.
 */
export function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadQuery = useRpc("threads.get", { id });
  const thread = threadQuery.data ?? null;
  const runsQuery = useRpc("runs.listForThread", { threadId: id });
  const runs = runsQuery.data ?? NO_RUNS;
  const activeRun = runs.at(-1);
  const settings = client.useConversationSettings({ thread, activeRun });
  useShareSettings(id, settings);
  useMarkSeen(thread);
  useCoverHome();
  const voices = useVoices(runs);
  const [disclosure] = useState(createDisclosure);
  const [{ live, working, generatingImage }, setActivity] = useState(IDLE);
  const actions = useThreadActions(thread, { onUnread: goBack });
  const now = useSnoozeClock();
  const panel = usePanelButton(thread);
  const menu = useMemo(() => thread && headerMenu(threadMenu(thread, "header", now), actions.run, panel), [thread, actions.run, now, panel]);
  const linkState = useLinkState();
  useThreadOnScreen(linkState.kind === "unpaired" ? null : linkState.mac.id, id);

  const { canSteer } = processFit({ live, activeRun, choice: settings.choice, mode: settings.mode, permission: settings.permission, compacting: false });
  const disabledReason =
    linkReason(linkState) ??
    conversationSendDisabledReason({
      permissionReady: settings.permissionReady,
      historyLoading: runsQuery.isLoading,
      historyFailed: Boolean(runsQuery.error),
      hasModel: Boolean(settings.choice),
    });
  const request: Omit<SubmitRequest, "now"> = {
    target: { kind: "thread", threadId: id },
    working,
    live,
    activeRun,
    agentsUsed: runs.map((run) => run.agent),
    choice: settings.choice,
    mode: settings.mode,
    permission: settings.permission,
    permissionReady: settings.permissionReady,
    compacting: false,
    waitForSave: settings.waitForSave,
  };

  const listRef = useRef<LegendListRef>(null);
  // The composer reports its height on layout, so the hook has nothing to measure up front.
  const unmeasured: Parameters<typeof useKeyboardChatComposerInset>[1] = useRef(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(listRef, unmeasured);
  useEffect(() => holdTranscriptList(listRef), []);
  const [sends, setSends] = useState(0);
  const follow = useCallback(() => setSends((count) => count + 1), []);

  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => <ThreadTitle thread={thread} onRename={actions.rename} /> }} />
      {menu}
      <DisclosureContext.Provider value={disclosure}>
        <VoicesContext.Provider value={voices}>
          <TranscriptPane
            threadId={id}
            thread={thread}
            runs={runs}
            loading={runsQuery.isLoading}
            failed={Boolean(runsQuery.error)}
            retry={() => void runsQuery.refetch()}
            onActivity={setActivity}
            composerInset={contentInsetEndAdjustment}
            listRef={listRef}
            followKey={sends}
          />
        </VoicesContext.Provider>
      </DisclosureContext.Provider>
      {perfEnabled() ? <PerfProbe /> : null}
      {thread ? (
        <View className="absolute inset-x-0 bottom-0">
          <Composer
            thread={thread}
            settings={settings}
            request={request}
            live={live && activeRun ? { runId: activeRun.id } : null}
            working={working}
            generatingImage={generatingImage}
            canSteer={canSteer}
            disabledReason={disabledReason}
            onLayout={onComposerLayout}
            onSent={follow}
          />
        </View>
      ) : null}
    </View>
  );
}

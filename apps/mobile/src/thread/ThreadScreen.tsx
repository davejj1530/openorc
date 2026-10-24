import type { LegendListRef } from "@legendapp/list/react-native";
import { useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { conversationActivity, conversationSendDisabledReason, processFit, type SubmitRequest } from "@openorc/client";
import type { Run, ThreadSummary } from "@openorc/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { client, useRpc } from "../client";
import { Composer } from "../composer/Composer";
import { useShareSettings } from "../composer/settings-bridge";
import { useCoverHome } from "../home/home-cover";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { holdTranscriptList, perfEnabled, reportThreadOpened } from "./perf-probe";
import { PerfProbe } from "./PerfProbe";
import { createDisclosure, DisclosureContext } from "./disclosure";
import { useMarkSeen } from "./mark-seen";
import { ThreadTitle, ThreadStop } from "./ThreadHeader";
import { Transcript } from "./Transcript";
import { VoicesContext, type Voice } from "./voices";

const NO_RUNS: Run[] = [];

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
  onActivity: (activity: Activity) => void;
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  followKey: number;
}

/**
 * The conversation itself, and the only part of the screen that hears every streamed frame: the header and the
 * composer hear only when the conversation starts or stops being busy.
 */
function TranscriptPane({ threadId, thread, runs, loading, onActivity, composerInset, listRef, followKey }: PaneProps) {
  const { merged, liveTranscript, hasOlder, loadOlder } = client.useConversationTranscript({ runs, threadId });
  const { live, working, generatingImage } = conversationActivity({ thread, activeRun: runs.at(-1), liveTranscript, compacting: false });
  useEffect(() => onActivity({ live, working, generatingImage }), [live, working, generatingImage, onActivity]);
  const [following, setFollowing] = useState(true);
  const blocks = merged?.blocks;
  useEffect(() => {
    if (blocks?.length) reportThreadOpened(threadId, blocks.length);
  }, [threadId, blocks?.length]);
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
    />
  );
}

/**
 * A thread on the phone: its conversation at phone size, from the newest turn back a page at a time, with the composer
 * pinned above the keyboard. The send tree, the paging and the settings are the desktop's, from @openorc/client.
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

  const { canSteer } = processFit({ live, activeRun, choice: settings.choice, mode: settings.mode, permission: settings.permission, compacting: false });
  const disabledReason = conversationSendDisabledReason({
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
      <Stack.Screen
        options={{
          headerTitle: () => <ThreadTitle thread={thread} />,
          headerRight: () => (live && working && activeRun ? <ThreadStop runId={activeRun.id} /> : null),
        }}
      />
      <DisclosureContext.Provider value={disclosure}>
        <VoicesContext.Provider value={voices}>
          <TranscriptPane
            threadId={id}
            thread={thread}
            runs={runs}
            loading={runsQuery.isLoading}
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

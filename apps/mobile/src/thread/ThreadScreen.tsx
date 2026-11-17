import { useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { conversationActivity, conversationSendDisabledReason, processFit, threadWriteBlock, type SubmitRequest } from "@openorc/client";
import { isSubagentThread, placeOf, type OrclingChatSummary, type Run, type ThreadCollaboration, type ThreadSummary } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { Pressable, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { client, useLinkState, useRpc } from "../client";
import { useThreadClaudeAccount } from "../composer/claude-account";
import { Composer } from "../composer/Composer";
import { useShareSettings } from "../composer/settings-bridge";
import { threadLinkReason } from "../connection/link-reason";
import { useOwnCloud } from "../cloud/use-own-cloud";
import type { LinkState } from "../connection/manager";
import { useCoverHome } from "../home/home-cover";
import { useThreadOnScreen } from "../notifications/on-screen";
import { chatFor, useOrclingChats } from "../orclings/orcling-chats";
import { OrclingChatPane } from "../orclings/OrclingChatPane";
import { OrclingHeader } from "../orclings/OrclingHeader";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { CloudFileScopeContext, useThreadFiles } from "../cloud/cloud-files";
import { threadTogetherOf, TogetherContext, turnSeen } from "./cloud-together";
import { createDisclosure, DisclosureContext } from "./disclosure";
import { useMarkSeen } from "./mark-seen";
import { AuthorsContext, useThreadAuthors } from "./thread-authors";
import { holdTranscriptList, perfEnabled, reportThreadOpened } from "./perf-probe";
import { PerfProbe } from "./PerfProbe";
import { useSnoozeClock } from "./snooze-clock";
import { SubagentStatusBar } from "./SubagentStatusBar";
import { ThreadTitle } from "./ThreadHeader";
import { useThreadHeaderMenu } from "./ThreadMenu";
import { NoteReplyContext, useMentionOpening, useNoteReading, useNoteReply, useThreadNotes } from "./thread-notes";
import { Transcript } from "./Transcript";
import { useThreadActions } from "./use-thread-actions";
import { VoicesContext, type Voice, type Voices } from "./voices";
import { useWaitingApprovals } from "./waiting-approvals";

const NO_RUNS: Run[] = [];
const goBack = () => router.back();

/** Each run's agent and model for the turn heads, and the thread's own, named as the catalog names the model. */
function useVoices(runs: Run[], thread: ThreadSummary | null): Voices {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  return useMemo(() => {
    const named = (agent: string, model: string | null): Voice => ({ agent, model: model ? (models.data?.find((option) => option.agent === agent && option.id === model)?.label ?? model) : null });
    return { runs: new Map(runs.map((run) => [run.id, named(run.agent, run.model)])), own: thread ? named(thread.agent, thread.model) : undefined };
  }, [runs, thread, models.data]);
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

/** Why the composer cannot send now: the link to the Mac first, for a thread that needs it, then the conversation's own state. */
function sendBlocked(
  link: LinkState,
  settings: { permissionReady: boolean; choice: unknown },
  runs: { isLoading: boolean; error: unknown },
  thread: ThreadSummary | null,
  ownCloud: boolean,
): string | null {
  return (
    threadLinkReason(link, thread, ownCloud) ??
    conversationSendDisabledReason({
      permissionReady: settings.permissionReady,
      historyLoading: runs.isLoading,
      historyFailed: Boolean(runs.error),
      hasModel: Boolean(settings.choice),
      thread,
    })
  );
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
  const notes = useThreadNotes(thread);
  const seeNotes = useNoteReading(threadId);
  const mention = useMentionOpening(thread);
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
      notes={notes}
      onNotesSeen={seeNotes}
      mention={mention}
    />
  );
}

/** An Orcling's own conversation names it in a pill by the back button; any other thread titles itself under its More menu. */
function ConversationHeader({ chat, title, menu }: { chat: OrclingChatSummary | null; title: (() => ReactElement) | null; menu: ReactElement | null }) {
  if (chat) return <OrclingHeader chat={chat} />;
  return (
    <>
      {/* No title until there is a thread to name: the bar sizes its title once, and a title that starts empty stays hidden unless a menu arrives to lay the bar out again. */}
      <Stack.Screen options={{ headerTitle: title ?? "" }} />
      {menu}
    </>
  );
}

/** An Orcling's own conversation reads as texting; any other as its work transcript. */
function ConversationPane({ chat, ...props }: PaneProps & { chat: OrclingChatSummary | null; thread: ThreadSummary }) {
  if (!chat) return <TranscriptPane {...props} />;
  const { thread, runs, loading, onActivity, composerInset, listRef, followKey } = props;
  return <OrclingChatPane chat={chat} thread={thread} runs={runs} loading={loading} onActivity={onActivity} composerInset={composerInset} listRef={listRef} followKey={followKey} />;
}

/** The thread the screen shows, and its runs; a retired team's conversation reads as none. */
function useOpenThread(id: string) {
  const threadQuery = useRpc("threads.get", { id });
  const thread = threadQuery.data?.teamInstanceId ? null : (threadQuery.data ?? null);
  const runsQuery = useRpc("runs.listForThread", { threadId: id });
  const runs = thread ? (runsQuery.data ?? NO_RUNS) : NO_RUNS;
  return { threadQuery, thread, runsQuery, runs, activeRun: runs.at(-1) };
}

/** The list under the composer: its ref, the room the composer and keyboard take, and a count that follows each send. */
function useTranscriptRoom() {
  const listRef = useRef<LegendListRef>(null);
  // The composer reports its height on layout, so the hook has nothing to measure up front.
  const unmeasured: Parameters<typeof useKeyboardChatComposerInset>[1] = useRef(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(listRef, unmeasured);
  useEffect(() => holdTranscriptList(listRef), []);
  const [sends, setSends] = useState(0);
  const follow = useCallback(() => setSends((count) => count + 1), []);
  return { listRef, composerInset: contentInsetEndAdjustment, onComposerLayout, sends, follow };
}

type Settings = ReturnType<typeof client.useConversationSettings> & { claudeAccountId?: string };

/** A send as this screen makes it. In an OpenOrc Cloud thread Send now names the turn the screen saw running. */
function submitRequest(input: {
  id: string;
  runs: Run[];
  activeRun: Run | undefined;
  settings: Settings;
  activity: { working: boolean; live: boolean };
  together: ThreadCollaboration | null;
}): Omit<SubmitRequest, "now"> {
  const { settings } = input;
  return {
    target: { kind: "thread", threadId: input.id },
    working: input.activity.working,
    live: input.activity.live,
    activeRun: input.activeRun,
    agentsUsed: input.runs.map((run) => run.agent),
    choice: settings.choice,
    mode: settings.mode,
    permission: settings.permission,
    permissionReady: settings.permissionReady,
    compacting: false,
    waitForSave: settings.waitForSave,
    ...turnSeen(input.together),
  };
}

/**
 * The conversation: a thread of this Mac or of OpenOrc Cloud, its transcript and its composer. Covering Home keeps the
 * list's own reads asleep; the header's More menu organizes a thread of this Mac; marking it unread goes back to Home,
 * since reading it here would mark it read again.
 */
export function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { threadQuery, thread, runsQuery, runs, activeRun } = useOpenThread(id);
  const settings = { ...client.useConversationSettings({ thread, activeRun }), claudeAccountId: thread?.claudeAccountId ?? undefined, claudeAccount: useThreadClaudeAccount(thread) };
  useShareSettings(id, settings);
  // An OpenOrc Cloud thread: its files go to the cloud through the phone's own session.
  const cloud = thread !== null && placeOf(thread).elsewhere;
  const together = threadTogetherOf(thread);
  useMarkSeen(thread);
  useCoverHome();
  const voices = useVoices(runs, thread);
  const [disclosure] = useState(createDisclosure);
  const [{ live, working, generatingImage }, setActivity] = useState(IDLE);
  const actions = useThreadActions(thread, { onUnread: goBack });
  const menu = useThreadHeaderMenu(thread, useSnoozeClock(), actions.run);
  const authors = useThreadAuthors(thread, together);
  const noteReply = useNoteReply(together);
  const linkState = useLinkState();
  const ownCloud = useOwnCloud();
  const files = useThreadFiles(cloud ? id : null);
  const chat = chatFor(useOrclingChats().chats, id);
  useThreadOnScreen(linkState.kind === "unpaired" ? null : linkState.mac.id, id);
  const { canSteer } = processFit({ live, activeRun, choice: settings.choice, mode: settings.mode, permission: settings.permission, compacting: false });
  const room = useTranscriptRoom();

  return (
    <View className="flex-1 bg-bg">
      <ConversationHeader chat={chat} title={thread ? () => <ThreadTitle thread={thread} onRename={actions.rename} /> : null} menu={menu} />
      <DisclosureContext.Provider value={disclosure}>
        <AuthorsContext.Provider value={authors}>
          <TogetherContext.Provider value={together}>
            <VoicesContext.Provider value={voices}>
              <CloudFileScopeContext.Provider value={files.readable}>
                <NoteReplyContext.Provider value={noteReply.value}>
                  {thread ? (
                    <ConversationPane
                      chat={chat}
                      threadId={id}
                      thread={thread}
                      runs={runs}
                      loading={runsQuery.isLoading}
                      failed={Boolean(runsQuery.error)}
                      retry={() => void runsQuery.refetch()}
                      onActivity={setActivity}
                      composerInset={room.composerInset}
                      listRef={room.listRef}
                      followKey={room.sends}
                    />
                  ) : (
                    <View className="flex-1 items-center justify-center">{threadQuery.isLoading ? <Spinner /> : <Text className="text-ink-4">Thread not found</Text>}</View>
                  )}
                </NoteReplyContext.Provider>
              </CloudFileScopeContext.Provider>
            </VoicesContext.Provider>
          </TogetherContext.Provider>
        </AuthorsContext.Provider>
      </DisclosureContext.Provider>
      {perfEnabled() ? <PerfProbe /> : null}
      {thread ? (
        <View className="absolute inset-x-0 bottom-0">
          {isSubagentThread(thread) ? (
            <SubagentStatusBar thread={thread} onLayout={room.onComposerLayout} />
          ) : (
            <Composer
              handle={noteReply.handle}
              thread={thread}
              queued={thread.queued}
              settings={settings}
              request={submitRequest({ id, runs, activeRun, settings, activity: { working, live }, together })}
              live={live && activeRun ? { runId: activeRun.id } : null}
              working={working}
              generatingImage={generatingImage}
              canSteer={canSteer}
              disabledReason={sendBlocked(linkState, settings, runsQuery, thread, ownCloud) ?? threadWriteBlock(thread)}
              onLayout={room.onComposerLayout}
              onSent={room.follow}
              to={chat?.name}
              turnSeen={turnSeen(together)}
              attachTo={files.attachTo}
              attachRefusal={files.attachRefusal}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

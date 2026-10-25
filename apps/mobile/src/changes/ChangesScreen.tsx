import { Host, Picker, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { comparisons, panelToolLabels } from "@openorc/client";
import type { ChangeComparison } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { RefreshControl, View } from "react-native";
import { useLinkState } from "../client";
import { linkReason } from "../connection/link-reason";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Spinner } from "../ui/Spinner";
import { changesLine } from "./change-words";
import { changesItems, ITEM_HEIGHTS, type ChangesItem } from "./changes-items";
import { CleanBlock, CommitRow, CommitsHead, FailedBlock, FileRow, UnlistedRow } from "./ChangeRows";
import { perfEnabled } from "../thread/perf-probe";
import { ChangesPerf } from "./ChangesPerf";
import { PanelTitle } from "./PanelTitle";
import { PublishBar } from "./PublishBar";
import { changeDrafts } from "./publishing";
import { useChangesReads, type ChangesReads } from "./use-changes";
import { usePublish } from "./use-publish";

/** A first read quicker than this shows no spinner at all. */
const SPINNER_DELAY_MS = 300;

function useLate(ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return late;
}

/** Uncommitted or the whole branch, for a worktree's thread: iOS's segmented control at its own width. */
function ComparePicker({ value, onChange }: { value: ChangeComparison; onChange: (next: ChangeComparison) => void }) {
  return (
    <View className="flex-row px-5 pb-2 pt-1">
      <Host matchContents colorScheme={useMode()}>
        <Picker selection={value} onSelectionChange={onChange} modifiers={[pickerStyle("segmented"), accessibilityLabel("Compare")]}>
          {comparisons.map(({ value: option, label }) => (
            <MenuText key={option} modifiers={[tag(option)]}>
              {label}
            </MenuText>
          ))}
        </Picker>
      </Host>
    </View>
  );
}

function Row({ item, open }: { item: ChangesItem; open: (path: string) => void }) {
  switch (item.kind) {
    case "file":
      return <FileRow file={item.file} onOpen={open} />;
    case "unlisted":
      return <UnlistedRow text={item.text} />;
    case "commits":
      return <CommitsHead text={item.text} />;
    case "commit":
      return <CommitRow commit={item.commit} unpushed={item.unpushed} />;
  }
}

interface ListProps {
  threadId: string;
  reads: ChangesReads;
  comparison: ChangeComparison;
  onComparison: (next: ChangeComparison) => void;
  footer: number;
  dim: boolean;
  list: RefObject<LegendListRef | null>;
}

/** The files, the count past the cap and the Commits section, with pull to refresh. */
function ChangesList({ threadId, reads, comparison, onComparison, footer, dim, list }: ListProps) {
  const late = useLate(SPINNER_DELAY_MS);
  const [refreshing, setRefreshing] = useState(false);
  const { changes, log, push, thread } = reads;
  const items = useMemo(() => changesItems(changes.data, log.data, push.data), [changes.data, log.data, push.data]);
  const open = useCallback((path: string) => router.push({ pathname: "/diff", params: { threadId, path, comparison } }), [threadId, comparison]);
  if (!changes.data && changes.error) return <FailedBlock message={changes.error.message} onRetry={() => void changes.refetch()} />;
  if (!changes.data) return <View className="flex-1 items-center justify-center">{late ? <Spinner /> : null}</View>;
  const where = thread.data?.workspaceMode === "worktree" ? "this thread's worktree" : (reads.project.data?.name ?? "this project");
  const refresh = () => {
    setRefreshing(true);
    void reads.refresh().finally(() => setRefreshing(false));
  };
  return (
    <LegendList
      ref={list}
      data={items}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.kind}
      getFixedItemSize={(item) => ITEM_HEIGHTS[item.kind]}
      recycleItems
      renderItem={({ item }) => <Row item={item} open={open} />}
      ListHeaderComponent={
        <View>
          {thread.data?.worktreePath ? <ComparePicker value={comparison} onChange={onComparison} /> : null}
          {changes.data.totals.files === 0 ? <CleanBlock where={where} /> : null}
        </View>
      }
      className={cn(dim && "opacity-60")}
      contentContainerStyle={{ paddingBottom: footer + 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColorClassName="accent-ink-3" />}
    />
  );
}

/**
 * A thread's changes, and the publish flow that follows them: the files with their counts, the branch's newest
 * commits, and a pinned bar whose ink pill is the next step of Commit, Push and PR. Each file opens its diff.
 */
export function ChangesScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const [comparison, setComparison] = useState<ChangeComparison>("head");
  const reads = useChangesReads(threadId, comparison);
  const publish = usePublish(threadId, reads);
  const dim = linkReason(useLinkState()) !== null;
  const [footer, setFooter] = useState(0);
  const list = useRef<LegendListRef>(null);
  useEffect(() => changeDrafts.setPanelTool(threadId, "changes"), [threadId]);
  const totals = reads.changes.data?.totals;
  const choose = (next: ChangeComparison) => {
    if (next === comparison) return;
    haptic.select();
    setComparison(next);
  };
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={panelToolLabels.changes} line={totals ? changesLine(totals) : null} /> }} />
      <ChangesList threadId={threadId} reads={reads} comparison={comparison} onComparison={choose} footer={footer} dim={dim} list={list} />
      {perfEnabled() ? <ChangesPerf reads={reads} list={list} /> : null}
      <View onLayout={({ nativeEvent }) => setFooter(nativeEvent.layout.height)} className="absolute inset-x-0 bottom-0">
        <PublishBar threadId={threadId} reads={reads} publish={publish} />
      </View>
    </View>
  );
}

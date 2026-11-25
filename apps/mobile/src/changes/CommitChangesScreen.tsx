import { LegendList } from "@legendapp/list/react-native";
import { relativeTime, shortSha } from "@openorc/client";
import type { Commit, WorkspaceChanges } from "@openorc/protocol";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { PanelHeader, usePanelNav, usePanelParams } from "../panel/host";
import { Measure } from "../ui/pane";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { changesLine } from "./change-words";
import { changesItems, ITEM_HEIGHTS, type ChangesItem } from "./changes-items";
import { FailedBlock, FileRow, NoFilesBlock, UnlistedRow } from "./ChangeRows";

type Params = { threadId: string; sha: string; cloud?: string };

/** A commit as its screen reads it, wherever the thread is: what it says of itself once known, and its files. */
interface CommitRead {
  commit: Pick<Commit, "subject" | "author" | "at"> | undefined;
  changes: Pick<WorkspaceChanges, "totals" | "files" | "unlisted"> | undefined;
  error: Error | null;
  retry: () => void;
}

/** From the thread's folder on the Mac, which answers for a short id too. */
function useMacCommit(threadId: string, sha: string, enabled: boolean): CommitRead {
  // A commit never changes, so it is read once.
  const read = useRpc("review.threadCommitChanges", { threadId, sha }, { enabled, staleTime: Infinity });
  return { commit: read.data?.commit, changes: read.data, error: read.error, retry: () => void read.refetch() };
}

/** From OpenOrc Cloud, which says what the commit is in the thread's list of commits. */
function useCloudCommit(threadId: string, sha: string, enabled: boolean): CommitRead {
  const read = useRpc("hosted.review.commit", { threadId, sha }, { enabled, staleTime: Infinity });
  const listed = useRpc("hosted.review.commits", { threadId }, { enabled });
  return { commit: listed.data?.commits.find((commit) => commit.sha === sha), changes: read.data, error: read.error, retry: () => void read.refetch() };
}

function Row({ item, open }: { item: ChangesItem; open: (path: string) => void }) {
  if (item.kind === "file") return <FileRow file={item.file} onOpen={open} />;
  return item.kind === "unlisted" ? <UnlistedRow text={item.text} /> : null;
}

/** What the commit says of itself, over its files: its subject whole, then who made it and when. */
function CommitHead({ commit, empty }: { commit: CommitRead["commit"]; empty: boolean }) {
  return (
    <View>
      {commit ? (
        <View accessible className="gap-1 px-5 pb-3 pt-2">
          <Text selectable className="text-md">
            {commit.subject}
          </Text>
          <Text className="text-sm text-ink-4">{[commit.author, relativeTime(commit.at)].filter(Boolean).join(" · ")}</Text>
        </View>
      ) : null}
      {empty ? <NoFilesBlock /> : null}
    </View>
  );
}

/**
 * One of a thread's commits as its changes against the commit before it: its id and counts in the bar, what it says of
 * itself, and its files, each opening its diff in that commit.
 */
export function CommitChangesScreen() {
  const { threadId, sha, cloud } = usePanelParams<Params>();
  const fromCloud = cloud !== undefined;
  const mac = useMacCommit(threadId, sha, !fromCloud);
  const hosted = useCloudCommit(threadId, sha, fromCloud);
  const { commit, changes, error, retry } = fromCloud ? hosted : mac;
  const insets = useSafeAreaInsets();
  const nav = usePanelNav();
  const open = useCallback(
    (path: string) => nav.open(fromCloud ? { name: "cloud-diff", params: { threadId, path, commit: sha } } : { name: "diff", params: { threadId, path, commit: sha } }),
    [nav, fromCloud, threadId, sha],
  );
  const items = useMemo(() => changesItems(changes, undefined, undefined), [changes]);
  const counts = changes ? changesLine(changes.totals) : null;
  let body = <View className="flex-1 items-center justify-center">{<WorkingMark />}</View>;
  if (error) body = <FailedBlock message={error.message} onRetry={retry} />;
  else if (changes)
    body = (
      <LegendList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        getFixedItemSize={(item) => ITEM_HEIGHTS[item.kind]}
        recycleItems
        renderItem={({ item }) => <Row item={item} open={open} />}
        ListHeaderComponent={<CommitHead commit={commit} empty={changes.totals.files === 0} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      />
    );
  return (
    <Measure className="flex-1 bg-bg">
      <PanelHeader title={`Commit ${shortSha(sha)}`} line={counts} fromCloud={fromCloud} />
      {body}
    </Measure>
  );
}

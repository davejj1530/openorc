import type { ChangeComparison, FileDiff, FolderPath } from "@openorc/protocol";
import { useRef, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { perfEnabled } from "../thread/perf-probe";
import { createSheetWindow, SheetWindowContext } from "../thread/sheet-window";
import { CopyText } from "../ui/Mono";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { cutText, diffLine, fileName, omittedText } from "./change-words";
import { FailedBlock } from "./ChangeRows";
import { DiffLines } from "./DiffLines";
import { DiffPerf } from "./DiffPerf";
import { PanelHeader, usePanelNav, usePanelParams, type PanelTool } from "../panel/host";

/** `commit` names the commit the file is read in; without it the file is one of the thread's changes. */
type Params = { threadId: string; path: string; comparison?: ChangeComparison; commit?: string };

/** The file's diff and the list it steps through: a commit's, or the thread's changes for the comparison. */
function useDiffReads({ threadId, path, comparison = "head", commit }: Params) {
  const inCommit = commit !== undefined;
  const sha = commit ?? "";
  const changed = useRpc("review.threadFileDiff", { threadId, comparison, path: path as FolderPath }, { enabled: !inCommit });
  const changes = useRpc("review.threadChanges", { threadId, comparison }, { enabled: !inCommit });
  // A commit never changes, so its reads are made once.
  const committed = useRpc("review.threadCommitFileDiff", { threadId, sha, path: path as FolderPath }, { enabled: inCommit, staleTime: Infinity });
  const commitChanges = useRpc("review.threadCommitChanges", { threadId, sha }, { enabled: inCommit, staleTime: Infinity });
  return { diff: inCommit ? committed : changed, files: (inCommit ? commitChanges.data : changes.data)?.files };
}

/** Previous and next file in the list's order, dimmed at either end. */
function fileSteps(paths: string[], path: string, go: (path: string) => void): PanelTool[] {
  const index = paths.indexOf(path);
  const step = (to: number) => () => {
    const next = paths[to];
    if (next !== undefined) go(next);
  };
  return [
    { kind: "button", icon: "chevron.up", label: "Previous file", disabled: index <= 0, onPress: step(index - 1) },
    { kind: "button", icon: "chevron.down", label: "Next file", disabled: index < 0 || index >= paths.length - 1, onPress: step(index + 1) },
  ];
}

function DiffBody({ diff }: { diff: FileDiff }) {
  const omitted = omittedText(diff.body);
  if (omitted)
    return (
      <View className="flex-1 items-center justify-center py-24">
        <Text className="text-ink-4">{omitted}</Text>
      </View>
    );
  return (
    <View className="gap-3">
      <DiffLines patch={diff.patch} />
      <View className="flex-row items-center justify-between px-5">
        {diff.cut ? <Text className="text-xs leading-4 text-ink-4">{cutText(diff.cut)}</Text> : <View />}
        <CopyText text={diff.patch} />
      </View>
    </View>
  );
}

/**
 * One file's diff, in the thread's changes or in one of its commits, read alone so a big branch never crosses the link
 * whole. The title is the file's name; the toolbar steps through the list's files in its order.
 */
export function DiffScreen() {
  const params = usePanelParams<Params>();
  const { path } = params;
  const nav = usePanelNav();
  const insets = useSafeAreaInsets();
  const { diff, files } = useDiffReads(params);
  const steps = fileSteps(files?.map((file) => file.path) ?? [], path, (next) => nav.setParams({ path: next }));
  const [sheet] = useState(createSheetWindow);
  const scroller = useRef<ScrollViewInstance>(null);
  const contentHeight = useRef(0);
  const scrolled = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => sheet.scrolled(nativeEvent.contentOffset.y, nativeEvent.layoutMeasurement.height);
  const laidOut = ({ nativeEvent }: LayoutChangeEvent) => sheet.scrolled(sheet.view().top, nativeEvent.layout.height);
  let body = (
    <View className="items-center py-24">
      <WorkingMark />
    </View>
  );
  if (diff.data) body = <DiffBody diff={diff.data} />;
  else if (diff.error) body = <FailedBlock message={diff.error.message} onRetry={() => void diff.refetch()} />;
  return (
    <SheetWindowContext.Provider value={sheet}>
      <PanelHeader title={fileName(path)} line={diff.data ? diffLine(diff.data) : null} tools={steps} />
      <ScrollView
        ref={scroller}
        className="flex-1 bg-bg"
        onScroll={scrolled}
        scrollEventThrottle={16}
        onLayout={laidOut}
        onContentSizeChange={(_width, height) => {
          contentHeight.current = height;
          sheet.resized();
        }}
      >
        <View ref={sheet.content} className="pt-2" style={{ paddingBottom: insets.bottom + 24, minHeight: "100%" }}>
          {body}
        </View>
      </ScrollView>
      {perfEnabled() ? <DiffPerf ready={Boolean(diff.data)} scroller={scroller} view={sheet.view} content={() => contentHeight.current} /> : null}
    </SheetWindowContext.Provider>
  );
}

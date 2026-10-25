import type { ChangeComparison, FileDiff, FolderPath } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { perfEnabled } from "../thread/perf-probe";
import { createSheetWindow, SheetWindowContext } from "../thread/sheet-window";
import { CopyText } from "../ui/Mono";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { cutText, diffLine, fileName, omittedText } from "./change-words";
import { FailedBlock } from "./ChangeRows";
import { DiffLines } from "./DiffLines";
import { DiffPerf } from "./DiffPerf";
import { PanelTitle } from "./PanelTitle";

type Params = { threadId: string; path: string; comparison?: ChangeComparison };

/** Previous and next file in the list's order, dimmed at either end. */
function FileSteps({ paths, path }: { paths: string[]; path: string }) {
  const index = paths.indexOf(path);
  const go = (to: number) => router.setParams({ path: paths[to] });
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="chevron.up" accessibilityLabel="Previous file" disabled={index <= 0} onPress={() => go(index - 1)} />
      <Stack.Toolbar.Button icon="chevron.down" accessibilityLabel="Next file" disabled={index < 0 || index >= paths.length - 1} onPress={() => go(index + 1)} />
    </Stack.Toolbar>
  );
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
 * One file's diff, read alone so a big branch never crosses the link whole. The title is the file's name; the
 * toolbar steps through the Changes list's files in its order.
 */
export function DiffScreen() {
  const { threadId, path, comparison = "head" } = useLocalSearchParams<Params>();
  const insets = useSafeAreaInsets();
  const diff = useRpc("review.threadFileDiff", { threadId, comparison, path: path as FolderPath });
  const list = useRpc("review.threadChanges", { threadId, comparison });
  const [sheet] = useState(createSheetWindow);
  const scroller = useRef<ScrollViewInstance>(null);
  const contentHeight = useRef(0);
  const scrolled = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => sheet.scrolled(nativeEvent.contentOffset.y, nativeEvent.layoutMeasurement.height);
  const laidOut = ({ nativeEvent }: LayoutChangeEvent) => sheet.scrolled(sheet.view().top, nativeEvent.layout.height);
  let body = (
    <View className="items-center py-24">
      <Spinner />
    </View>
  );
  if (diff.data) body = <DiffBody diff={diff.data} />;
  else if (diff.error) body = <FailedBlock message={diff.error.message} onRetry={() => void diff.refetch()} />;
  return (
    <SheetWindowContext.Provider value={sheet}>
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={fileName(path)} line={diff.data ? diffLine(diff.data) : null} /> }} />
      <FileSteps paths={list.data?.files.map((file) => file.path) ?? []} path={path} />
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

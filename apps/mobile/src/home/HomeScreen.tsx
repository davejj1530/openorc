import { LegendList } from "@legendapp/list/react-native";
import { threadListParams } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { Link } from "expo-router";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useRpc, useRpcs } from "../client";
import { linkWords } from "../connection/link-words";
import type { LinkState } from "../connection/manager";
import { Plus } from "../generated/icons";
import { LinkDot } from "../macs/LinkDot";
import { reportFirstFrame } from "../startup";
import { Text } from "../ui/Text";
import { HomeHeading, PinnedLabel } from "./HomeHeading";
import { homeItems, type HomeItem } from "./home-items";
import { ThreadRow } from "./ThreadRow";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;

function HomeRow({ item }: { item: HomeItem }) {
  switch (item.kind) {
    case "heading":
      return <HomeHeading heading={item} />;
    case "pinned":
      return <PinnedLabel count={item.count} />;
    case "thread":
      return <ThreadRow thread={item.thread} project={item.project} />;
  }
}

/** The title, the Mac this shows with its connection dot, and a quiet line while the phone is not connected. */
function Title({ state }: { state: Paired }) {
  const words = linkWords(state);
  return (
    <View className="px-5 pb-1 pt-3">
      <View className="flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-title-sm">
          Threads
        </Text>
        <Link href="/macs" asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${state.mac.name}, ${words.status}`}
            className="-mr-3 h-touch max-w-48 flex-row items-center gap-2 rounded-full px-3 active:bg-surface-2"
          >
            <LinkDot tone={words.tone} />
            <Text numberOfLines={1} className="text-sm text-ink-4">
              {state.mac.name}
            </Text>
          </Pressable>
        </Link>
      </View>
      {words.line ? <Text className="text-sm text-ink-4">{words.line}</Text> : null}
    </View>
  );
}

function Threads({ state }: { state: Paired }) {
  const insets = useSafeAreaInsets();
  const projects = useRpc("projects.list", {});
  const groups = [{ id: WORKSPACE_ID, name: "Workspace" }, ...(projects.data ?? []).map(({ id, name }) => ({ id, name }))];
  const lists = useRpcs(
    "threads.list",
    groups.map((group) => threadListParams(group.id, "active")),
    { refetchInterval: 60_000 },
  );
  const items = homeItems(
    groups.map((group, index) => ({ ...group, threads: lists[index]?.data })),
    Date.now(),
  );
  return (
    <LegendList
      data={items}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.kind}
      recycleItems
      renderItem={({ item }) => <HomeRow item={item} />}
      ListHeaderComponent={<Title state={state} />}
      ListFooterComponent={<View className="h-24" />}
      contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    />
  );
}

/** No Mac yet: one quiet way in. */
function Unpaired() {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-10">
      <Text accessibilityRole="header" className="text-xl">
        Pair with your Mac
      </Text>
      <Text className="text-center text-ink-4">Scan the code OpenOrc shows on your Mac.</Text>
      <Link href="/pair" asChild>
        <Pressable accessibilityRole="button" className="mt-4 h-touch justify-center rounded-full bg-accent px-5 active:opacity-80">
          <Text className="text-md text-accent-fg">Scan code</Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** Home: the shown Mac's threads grouped by project on the tile ground, with New thread as the screen's one ink pill. */
export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const state = useLinkState();
  useEffect(reportFirstFrame, []);
  if (state.kind === "unpaired") {
    return (
      <View className="flex-1 bg-bg">
        <Unpaired />
      </View>
    );
  }
  return (
    <View className="flex-1 bg-bg">
      <Threads state={state} />
      {/* Rows scroll under the status bar on the tile, not over it. */}
      <View className="absolute inset-x-0 top-0 bg-bg" style={{ height: insets.top }} />
      <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 items-center" style={{ paddingBottom: insets.bottom }}>
        <Pressable accessibilityRole="button" className="mb-2 h-touch flex-row items-center gap-2 rounded-full bg-accent pl-4 pr-5 active:opacity-80">
          <Plus size={16} className="text-accent-fg" />
          <Text className="text-md text-accent-fg">New thread</Text>
        </Pressable>
      </View>
    </View>
  );
}

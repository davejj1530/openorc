import { LegendList } from "@legendapp/list/react-native";
import { useEffect, useMemo } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus } from "../generated/icons";
import { reportFirstFrame } from "../startup";
import { Text } from "../ui/Text";
import { fixtureProjects, fixtureThreads } from "./fixtures";
import { HomeHeading, PinnedLabel } from "./HomeHeading";
import { homeItems, type HomeItem } from "./home-items";
import { ThreadRow } from "./ThreadRow";

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

function Title() {
  return (
    <View className="px-5 pb-1 pt-3">
      <Text accessibilityRole="header" className="text-title-sm">
        Threads
      </Text>
    </View>
  );
}

/** Home: threads grouped by project on the tile ground, with New thread as the screen's one ink pill. */
export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const items = useMemo(() => homeItems(fixtureProjects, fixtureThreads), []);
  useEffect(reportFirstFrame, []);
  return (
    <View className="flex-1 bg-bg">
      <LegendList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        recycleItems
        renderItem={({ item }) => <HomeRow item={item} />}
        ListHeaderComponent={Title}
        ListFooterComponent={<View className="h-24" />}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      />
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

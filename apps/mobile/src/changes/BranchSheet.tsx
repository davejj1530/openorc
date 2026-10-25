import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, TextInput, View } from "react-native";
import { Check, Search } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { SheetHeader } from "../ui/SheetHeader";
import { Text } from "../ui/Text";
import { usePullRequestForm } from "./pull-request-form";
import { useChangesReads } from "./use-changes";

const back = () => router.back();

/** Every branch a pull request can target, searched by name, for repositories with more than a menu holds. */
export function BranchSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const reads = useChangesReads(threadId, "head");
  const form = usePullRequestForm(threadId, reads);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? form.options.filter((branch) => branch.toLowerCase().includes(needle)) : form.options;
  }, [form.options, query]);
  const pick = (base: string) => {
    if (base !== form.base) {
      haptic.select();
      form.edit({ base });
    }
    back();
  };
  // The sheet's list is its root, as iOS sheets expect; the title and the search stick to its top.
  return (
    <FlatList
      className="flex-1 bg-bg"
      data={shown}
      keyExtractor={(branch) => branch}
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={[0]}
      onAccessibilityEscape={back}
      ListHeaderComponent={
        <View className="bg-bg pb-2">
          <SheetHeader title="Target branch" onClose={back} />
          <View className="mx-5 h-touch flex-row items-center gap-2 rounded-full bg-surface px-4">
            <Search size={16} className="text-ink-4" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search"
              placeholderTextColorClassName="accent-ink-4"
              accessibilityLabel="Search branches"
              className="flex-1 p-0 font-sans text-md text-ink"
            />
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <ListPressable
          accessibilityRole="button"
          accessibilityState={{ selected: item === form.base }}
          onPress={() => pick(item)}
          className="h-touch flex-row items-center gap-3 px-5 active:bg-surface-2"
        >
          <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-sm">
            {item}
          </Text>
          {item === form.base ? <Check size={16} className="text-ink-2" /> : null}
        </ListPressable>
      )}
    />
  );
}

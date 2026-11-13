import { WORKSPACE_ID } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSharedSettings } from "../composer/settings-bridge";
import { Check, Folder, FolderOpen, Globe, Search, X } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";

function closeSheet() {
  Keyboard.dismiss();
  router.back();
}

/** A searchable list of the new thread's projects, including Workspace. */
export function ProjectSheet() {
  const { composerId } = useLocalSearchParams<{ composerId: string }>();
  const project = useSharedSettings(composerId)?.project;
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const choices = (project?.choices ?? []).filter((choice) => choice.name.toLocaleLowerCase().includes(search));
  const scroll = useRef<ScrollViewInstance>(null);
  const viewport = useRef(0);
  const currentRow = useRef<{ y: number; height: number } | null>(null);
  const revealed = useRef(false);
  const reveal = () => {
    if (revealed.current || search || !viewport.current || !currentRow.current) return;
    revealed.current = true;
    scroll.current?.scrollTo({ y: Math.max(0, currentRow.current.y - (viewport.current - currentRow.current.height) / 2), animated: false });
  };
  return (
    <ScrollView
      ref={scroll}
      className="flex-1 bg-surface"
      stickyHeaderIndices={[0]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      showsVerticalScrollIndicator={false}
      onAccessibilityEscape={closeSheet}
      onLayout={({ nativeEvent }) => {
        viewport.current = nativeEvent.layout.height;
        reveal();
      }}
    >
      <View collapsable={false} className="gap-3 bg-surface px-3 pb-3 pt-5">
        <View className="h-touch flex-row items-center justify-between px-1">
          <Text accessibilityRole="header" className="text-xl">
            Choose project
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close project picker"
            onPress={closeSheet}
            hitSlop={6}
            className="h-control-lg w-8 items-center justify-center rounded-full bg-surface-2 active:bg-surface-3"
          >
            <X size={16} className="text-ink-3" />
          </Pressable>
        </View>
        <View className="h-touch flex-row items-center gap-2 rounded-lg bg-surface-2 px-3">
          <Search size={16} className="text-ink-4" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            placeholder="Search projects"
            placeholderTextColorClassName="accent-ink-4"
            accessibilityLabel="Search projects"
            className="min-w-0 flex-1 p-0 font-sans text-md text-ink"
          />
        </View>
      </View>
      {choices.map((choice) => {
        const on = choice.id === project?.chosen;
        const FolderIcon = on ? FolderOpen : Folder;
        const Icon = choice.id === WORKSPACE_ID ? Globe : FolderIcon;
        return (
          <ListPressable
            key={choice.id}
            accessibilityRole="radio"
            accessibilityLabel={choice.name}
            accessibilityState={{ checked: on, disabled: project?.disabled }}
            disabled={project?.disabled}
            onPress={() => {
              if (!project || project.disabled) return;
              if (!on) {
                haptic.select();
                project.select(choice.id);
              }
              closeSheet();
            }}
            onLayout={({ nativeEvent }) => {
              if (!on) return;
              currentRow.current = nativeEvent.layout;
              reveal();
            }}
            className={cn("mx-3 min-h-touch-row flex-row items-center gap-3 rounded-md px-3 active:bg-surface-3", on && "bg-surface-2", choice.id === WORKSPACE_ID && "mb-2")}
          >
            <Icon size={18} className="text-ink-3" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-md">
              {choice.name}
            </Text>
            {on ? <Check size={16} /> : null}
          </ListPressable>
        );
      })}
      {!choices.length ? <Text className="px-6 py-6 text-center text-md text-ink-3">No projects found</Text> : null}
    </ScrollView>
  );
}

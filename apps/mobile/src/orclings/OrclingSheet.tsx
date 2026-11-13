import { isHarnessId, type OrclingProfile } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import Animated, { useAnimatedRef, useScrollOffset } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc, useRpcMutation } from "../client";
import { useShareSettings } from "../composer/settings-bridge";
import { Pencil, Trash2 } from "../generated/icons";
import { Card, Divider, RowLines, rowClass, Section } from "../settings/parts";
import { holdsSecret } from "../tasks/task-edit";
import { Markdown } from "../thread/Markdown";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { SheetHeader } from "../ui/SheetHeader";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { CheckIns } from "./CheckIns";
import { OrclingFace } from "./OrclingFace";
import { nameProblem, useOrclingEdit, whenSaved, type OrclingEdit } from "./orcling-edit";
import { ModelRow, PermissionRow } from "./OrclingRows";

const close = () => router.back();
/** Instructions taller than this fold to it until asked for the rest. */
const FOLDED_HEIGHT = 240;

type Save = (edit: OrclingEdit) => Promise<boolean>;

/** Its face, which opens its look, as a contact's photo does. */
function Hero({ profile }: { profile: OrclingProfile }) {
  const open = () => router.push({ pathname: "/orcling-look", params: { id: profile.id } });
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Change ${profile.name}’s look`} onPress={open} className="items-center gap-2 self-center active:opacity-70">
      <OrclingFace look={profile.look} size={96} />
      <Text className="text-sm text-ink-3">Edit look</Text>
    </Pressable>
  );
}

/** The rename prompt; a name the Mac would refuse says why there, before anything is sent. */
function rename(current: string, others: readonly string[], save: Save) {
  Alert.prompt(
    "Rename Orcling",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Save",
        isPreferred: true,
        onPress: (typed?: string) => {
          const name = (typed ?? "").trim();
          if (!name || name === current) return;
          const problem = nameProblem(name, others);
          if (problem) return Alert.alert("Choose another name", problem);
          void save({ name });
        },
      },
    ],
    "plain-text",
    current,
  );
}

/** Who it is and what it runs on, each changed in place and saved at once, as its designer on the Mac changes them. */
function Identity({ profile, save, composerId }: { profile: OrclingProfile; save: Save; composerId: string }) {
  const chats = useRpc("orclings.chats", {});
  const others = (chats.data ?? []).filter((chat) => chat.id !== profile.id).map((chat) => chat.name);
  return (
    <Card>
      <ListPressable
        accessibilityRole="button"
        accessibilityLabel={`Name, ${profile.name}`}
        accessibilityHint="Renames it"
        onPress={() => rename(profile.name, others, save)}
        className={cn(rowClass, "active:bg-surface-2")}
      >
        <RowLines
          lead={<Pencil size={16} className="text-ink-4" />}
          label="Name"
          trailing={
            <Text numberOfLines={1} className="max-w-56 text-md text-ink-4">
              {profile.name}
            </Text>
          }
        />
      </ListPressable>
      <Divider />
      <ModelRow settings={profile.settings} composerId={composerId} />
      <Divider />
      <PermissionRow value={profile.permission} onChange={(permission) => void save({ permission })} />
    </Card>
  );
}

/**
 * Its current instructions as the Markdown they are, folded when long with the rest one tap away, and Edit to rewrite
 * them. Ones that hold a secret reach the phone redacted, so saving them here would lose the secret: they say so.
 */
function Instructions({ profile }: { profile: OrclingProfile }) {
  const text = profile.instructions;
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const folds = height > FOLDED_HEIGHT;
  const secret = holdsSecret(text);
  const edit = () =>
    secret
      ? Alert.alert("Edit these on your Mac", "They hold a secret your phone only sees redacted, so saving them here would lose it.")
      : router.push({ pathname: "/orcling-instructions", params: { id: profile.id } });
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <Text accessibilityRole="header" className="text-sm text-ink-4">
          Instructions
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${profile.name}’s instructions`} onPress={edit} hitSlop={10} className="active:opacity-60">
          <Text className={cn("text-sm", secret ? "text-ink-4" : "text-ink-2")}>Edit</Text>
        </Pressable>
      </View>
      <Card>
        <View className="gap-2 px-4 py-3.5">
          {text ? (
            <View style={open ? undefined : { maxHeight: FOLDED_HEIGHT, overflow: "hidden" }}>
              {/* A heading's room above it is for one under a paragraph; at the card's top, as in a chat bubble, it goes. */}
              <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)} className={/^\s*#/.test(text) ? "-mt-5" : undefined}>
                <Markdown text={text} streaming={false} />
              </View>
            </View>
          ) : (
            <Text className="text-md text-ink-4">None yet</Text>
          )}
          {text && folds ? (
            <Pressable accessibilityRole="button" onPress={() => setOpen((shown) => !shown)} hitSlop={8} className="self-start active:opacity-60">
              <Text className="text-sm text-ink-3">{open ? "Show less" : "Show all"}</Text>
            </Pressable>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

function Memories({ memories }: { memories: OrclingProfile["memories"] }) {
  return (
    <Section title="Memory">
      <Card>
        {memories.length ? (
          memories.map((memory, index) => (
            <View key={memory.id}>
              {index ? <Divider /> : null}
              <View className="gap-0.5 px-4 py-3">
                <Text className="text-md">{memory.title}</Text>
                <Text numberOfLines={3} className="text-sm text-ink-4">
                  {memory.body}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <View className="px-4 py-3.5">
            <Text className="text-md text-ink-4">Nothing remembered yet</Text>
          </View>
        )}
      </Card>
    </Section>
  );
}

/** Deleting it takes its conversation, instructions and memories; threads it worked in keep their history. Home is where that leaves you. */
function DeleteOrcling({ profile }: { profile: OrclingProfile }) {
  const remove = useRpcMutation("orclings.delete");
  const confirm = () =>
    Alert.alert(`Delete ${profile.name}?`, "Its conversation, instructions and memories go with it. Threads it worked in keep their history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void whenSaved(profile.id).then(() =>
            remove.mutate(
              { id: profile.id },
              {
                onSuccess: () => {
                  haptic.confirm();
                  router.dismissTo("/");
                },
                onError: (error) => {
                  haptic.warn();
                  Alert.alert(`Couldn’t delete ${profile.name}`, error.message);
                },
              },
            ),
          ),
      },
    ]);
  return (
    <Card>
      <ListPressable accessibilityRole="button" disabled={remove.isPending} onPress={confirm} className={cn(rowClass, "active:bg-surface-2")}>
        <RowLines lead={<Trash2 size={16} className="text-bad" />} label={`Delete ${profile.name}`} labelClassName="text-bad" />
      </ListPressable>
    </Card>
  );
}

/**
 * The model sheet, opened from the Model row, changes this Orcling's model, effort, Fast mode and, for Claude, its
 * account, as it changes a composer's: each pick saves at once.
 */
function useShareModel(composerId: string, profile: OrclingProfile | undefined, save: Save) {
  useShareSettings(composerId, {
    choice: profile ? profile.settings : null,
    selectModel: (choice) => {
      if (!isHarnessId(choice.agent)) return;
      void save({ settings: { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: Boolean(choice.fastMode) } });
    },
    ...(profile ? { claudeAccount: { chosen: profile.claudeAccountId, select: (claudeAccountId: string) => void save({ claudeAccountId }) } } : {}),
  });
}

/**
 * An Orcling, opened from the pill in its chat: its face, name, model and permission, when it checks in, its
 * instructions and what it remembers. Everything its designer and panel on the Mac change, changes here too, except its
 * earlier instructions and what it remembers.
 */
export function OrclingSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useRpc("orclings.profile", { id });
  const { shown, save } = useOrclingEdit(profile.data);
  const composerId = `orcling:${id}`;
  useShareModel(composerId, shown, save);
  const insets = useSafeAreaInsets();
  const scroller = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollOffset(scroller);
  return (
    <Animated.ScrollView ref={scroller} className="flex-1 bg-bg" stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} onAccessibilityEscape={close}>
      <SheetHeader title={shown?.name ?? ""} scrollY={scrollY} onClose={close} />
      {shown ? (
        <View className="gap-7 px-5 pt-2">
          <Hero profile={shown} />
          <Identity profile={shown} save={save} composerId={composerId} />
          <CheckIns id={shown.id} wakes={shown.wakes} />
          <Instructions profile={shown} />
          <Memories memories={shown.memories} />
          <DeleteOrcling profile={shown} />
        </View>
      ) : (
        <View className="items-center pt-16">{profile.error ? <Text className="px-8 text-center text-ink-3">{profile.error.message}</Text> : <Spinner />}</View>
      )}
    </Animated.ScrollView>
  );
}

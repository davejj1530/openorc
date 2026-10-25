import { Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { ChevronsUpDown } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { SheetStatusBar } from "../ui/SheetStatusBar";
import { Text } from "../ui/Text";
import { NoticeText } from "./PublishBar";
import { openPullRequest } from "./publish-actions";
import { MENU_BRANCHES, usePullRequestForm } from "./pull-request-form";
import { Field, SheetPill } from "./SheetParts";
import { useChangesReads } from "./use-changes";
import { usePublish } from "./use-publish";

const back = () => router.back();
const input = "px-4 py-3 font-sans text-md leading-5 text-ink";

type Form = ReturnType<typeof usePullRequestForm>;

function TargetLine({ base, loading }: { base: string | null; loading: boolean }) {
  return (
    <View pointerEvents="none" className="min-h-touch-row flex-row items-center gap-2 px-4">
      <Text numberOfLines={1} className={cn("min-w-0 flex-1 font-mono text-sm", loading && "text-ink-4")}>
        {base ?? ""}
      </Text>
      <ChevronsUpDown size={14} className="text-ink-4" />
    </View>
  );
}

/** The target as a native menu with a check on the current branch, or, past 20 branches, a row to the search sheet. */
function TargetBranch({ threadId, form, locked }: { threadId: string; form: Form; locked: boolean }) {
  const mode = useMode();
  const loading = form.branches.isPending;
  if (form.options.length > MENU_BRANCHES)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Target branch, ${form.base ?? ""}`}
        disabled={locked}
        onPress={() => router.push({ pathname: "/branch", params: { threadId } })}
        className="active:bg-surface-2"
      >
        <TargetLine base={form.base} loading={false} />
      </Pressable>
    );
  return (
    <Host matchContents={{ vertical: true }} colorScheme={mode}>
      <Menu
        modifiers={[accessibilityLabel("Target branch"), accessibilityValue(form.base ?? "")]}
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <TargetLine base={form.base} loading={loading} />
          </RNHostView>
        }
      >
        <Picker
          selection={form.base ?? ""}
          onSelectionChange={(base: string) => {
            if (locked || base === form.base) return;
            haptic.select();
            form.edit({ base });
          }}
          modifiers={[pickerStyle("inline")]}
        >
          {form.options.map((branch) => (
            <MenuText key={branch} modifiers={[tag(branch)]}>
              {branch}
            </MenuText>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}

/**
 * A new pull request through the Mac's gh: target, title and body, as the desktop's dialog has them. Everything holds
 * while it opens; an opened one closes the sheet and the screen names it. Refusals stay here, with their full text.
 */
export function PullRequestSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const bottom = useSheetBottom(24);
  const reads = useChangesReads(threadId, "head");
  const { publishing, view, mac } = usePublish(threadId, reads);
  const form = usePullRequestForm(threadId, reads);
  const [asked, setAsked] = useState<string | null>(null);
  const started = useRef(false);
  const locked = publishing.kind === "running" || (publishing.kind === "lost" && publishing.lost.action === "pr");
  const step = view?.pullRequest?.kind === "open" ? view.pullRequest.step : null;
  const reason = step?.reason ?? null;
  const ready = Boolean(form.title.trim() && form.base);
  useEffect(() => setAsked(null), [reason]);
  useEffect(() => {
    if (started.current && publishing.kind === "notice" && publishing.action === "pr" && publishing.tone === "muted") router.back();
  }, [publishing]);
  const open = () => {
    if (locked || !ready || !form.base) return;
    if (reason) {
      haptic.warn();
      return setAsked(reason);
    }
    started.current = true;
    void openPullRequest(threadId, { title: form.title.trim(), body: form.body, base: form.base });
  };
  const failure = publishing.kind === "notice" && publishing.action === "pr" && publishing.tone === "bad" ? publishing : null;
  return (
    <>
      <SheetStatusBar />
      <Stack.Screen options={{ gestureEnabled: !locked }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-bg"
        stickyHeaderIndices={[0]}
        contentContainerStyle={{ paddingBottom: bottom }}
        onAccessibilityEscape={() => !locked && back()}
      >
        <SheetHeader title="Open a pull request" onClose={back} locked={locked} />
        <View className="gap-5 px-5 pt-1">
          <View className="gap-2">
            <Field label="Target branch">
              <TargetBranch threadId={threadId} form={form} locked={locked} />
            </Field>
            {form.branches.error ? <Text className="px-4 text-sm text-bad">{form.branches.error.message}</Text> : null}
          </View>
          <Field label="Title">
            <TextInput value={form.title} editable={!locked} onChangeText={(title) => form.edit({ title })} accessibilityLabel="Title" className={input} />
          </Field>
          <Field label="Body">
            <TextInput
              multiline
              value={form.body}
              editable={!locked}
              onChangeText={(body) => form.edit({ body })}
              placeholder="What this changes and how to check it"
              placeholderTextColorClassName="accent-ink-4"
              accessibilityLabel="Body"
              className={cn(input, "min-h-40")}
              textAlignVertical="top"
            />
          </Field>
          {publishing.kind === "lost" ? <Text className="px-4 text-sm text-ink-3">Lost {mac} before it answered.</Text> : null}
          {asked ? <Text className="px-4 text-sm text-ink-3">{asked}</Text> : null}
          {failure ? (
            <View className="px-4">
              <NoticeText notice={failure} threadId={threadId} />
            </View>
          ) : null}
          <SheetPill label={locked ? "Opening…" : "Open PR"} dim={!ready || Boolean(reason)} running={locked} onPress={open} />
        </View>
      </ScrollView>
    </>
  );
}

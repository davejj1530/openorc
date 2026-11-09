import { newThreadChoice, type ModelChoice } from "@openorc/client";
import { defaultOrclingLook, isHarnessId, type ModelExecutionSettings, type OrclingLook, type OrclingLookPart, type OrclingPermission } from "@openorc/protocol";
import { router, Stack } from "expo-router";
import { useContext, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { useRpc, useRpcMutation } from "../client";
import { SheetPill } from "../changes/SheetParts";
import { useShareSettings } from "../composer/settings-bridge";
import { HostContext } from "../connection/host-context";
import { Pencil } from "../generated/icons";
import { Card, Divider, rowClass } from "../settings/parts";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { Text } from "../ui/Text";
import { LookColors, Options, PartTabs } from "./LookPicker";
import { NAME_MAX, nameProblem } from "./orcling-edit";
import { OrclingMotion, seedOf } from "./OrclingMotion";
import { ModelRow, PermissionRow } from "./OrclingRows";
import { PinnedSheet } from "./PinnedSheet";

const COMPOSER_ID = "orcling-new";
const back = () => router.back();
const sameLook = (a: OrclingLook, b: OrclingLook) => (Object.keys(a) as (keyof OrclingLook)[]).every((key) => a[key] === b[key]);

/**
 * The model a new Orcling starts on: the Mac's default for new work, as a new thread's, until another is picked.
 * `loading` holds until the Mac has said what it offers; a Mac with no agent to run offers none.
 */
function useStartingModel() {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const harnesses = useRpc("agents.availability", {});
  const settings = useRpc("app.settings.get", {});
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const loading = !models.data || !harnesses.data || !settings.data;
  const fallback = loading ? null : newThreadChoice(models.data, { preferred: settings.data.defaultHarness, harnesses: harnesses.data });
  return { choice: picked ?? fallback, pick: setPicked, picked: picked !== null, loading };
}

const asSettings = (choice: ModelChoice | null): ModelExecutionSettings | null =>
  choice && isHarnessId(choice.agent) ? { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: Boolean(choice.fastMode) } : null;

/** Its name, typed here and checked as it is typed, then what it runs on and how freely, as on its profile. */
function Identity({
  name,
  onName,
  problem,
  settings,
  loading,
  permission,
  onPermission,
  locked,
}: {
  name: string;
  onName: (name: string) => void;
  problem: string | null;
  settings: ModelExecutionSettings | null;
  loading: boolean;
  permission: OrclingPermission;
  onPermission: (permission: OrclingPermission) => void;
  locked: boolean;
}) {
  return (
    <View className="gap-2 px-5">
      <Card>
        <View className={rowClass}>
          <View className="flex-row items-center gap-3">
            <View className="size-4 items-center justify-center">
              <Pencil size={16} className="text-ink-4" />
            </View>
            <TextInput
              value={name}
              onChangeText={onName}
              maxLength={NAME_MAX}
              editable={!locked}
              placeholder="Name"
              placeholderTextColorClassName="accent-ink-4"
              accessibilityLabel="Name"
              autoCorrect={false}
              returnKeyType="done"
              className="flex-1 p-0 font-sans text-md text-ink"
            />
          </View>
        </View>
        <Divider />
        <ModelRow settings={settings} loading={loading} composerId={COMPOSER_ID} />
        <Divider />
        <PermissionRow value={permission} onChange={onPermission} />
      </Card>
      {problem ? (
        <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A new Orcling, as the Mac's designer makes one: its face moving at the top as it is drawn, its name, model and
 * permission, then its look one part at a time. It starts as the classic Orcling on the Mac's default model, asking
 * before it acts. Made, it opens its chat.
 */
export function NewOrclingSheet() {
  const host = useContext(HostContext);
  const [name, setName] = useState("");
  const [look, setLook] = useState<OrclingLook>(defaultOrclingLook);
  const [part, setPart] = useState<OrclingLookPart>("shape");
  const [permission, setPermission] = useState<OrclingPermission>("approve");
  const model = useStartingModel();
  const [account, setAccount] = useState<string | undefined>();
  const chats = useRpc("orclings.chats", {});
  const create = useRpcMutation("orclings.create");
  const settings = asSettings(model.choice);
  useShareSettings(COMPOSER_ID, { choice: model.choice, selectModel: model.pick, claudeAccount: { chosen: account, select: setAccount } });
  const problem = nameProblem(
    name,
    (chats.data ?? []).map((chat) => chat.name),
  );
  const ready = Boolean(name.trim() && !problem && settings);
  const dirty = Boolean(name.trim()) || !sameLook(look, defaultOrclingLook) || model.picked || Boolean(account) || permission !== "approve";
  const creating = create.isPending;
  const close = () =>
    dirty
      ? Alert.alert("Discard this Orcling?", undefined, [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: back },
        ])
      : back();
  const submit = () => {
    if (!ready || !settings || creating) return;
    create.mutate(
      { draft: { name: name.trim(), look, settings, permission, ...(account ? { claudeAccountId: account } : {}) } },
      {
        onSuccess: (orcling) => {
          haptic.confirm();
          back();
          router.push({ pathname: "/thread/[id]", params: host ? { id: orcling.threadId, host } : { id: orcling.threadId } });
        },
        onError: () => haptic.warn(),
      },
    );
  };
  return (
    <PinnedSheet
      onAccessibilityEscape={close}
      top={
        <>
          <Stack.Screen options={{ gestureEnabled: !dirty && !creating }} />
          <SheetHeader title="New Orcling" onClose={close} locked={creating} />
          <View className="items-center pb-3">
            <OrclingMotion look={look} size={120} seed={seedOf(COMPOSER_ID)} mood="rest" paused={false} />
          </View>
        </>
      }
      footer={
        <>
          {create.error ? (
            <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
              {create.error.message}
            </Text>
          ) : null}
          <SheetPill label={creating ? "Creating…" : "Create Orcling"} dim={!ready} running={creating} onPress={submit} />
        </>
      }
      contentContainerStyle={{ paddingTop: 8, gap: 24 }}
    >
      <Identity name={name} onName={setName} problem={problem} settings={settings} loading={model.loading} permission={permission} onPermission={setPermission} locked={creating} />
      <PartTabs part={part} onPick={setPart} />
      <View className="gap-6 px-5">
        <Options look={look} part={part} onChange={setLook} />
        <LookColors look={look} part={part} onChange={setLook} />
      </View>
    </PinnedSheet>
  );
}

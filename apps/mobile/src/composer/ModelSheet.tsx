import { modelChoiceFor, pickerCatalog, pickerSettings, catalogModel, type ModelChoice } from "@openorc/client";
import { effortLabel, harnessShortName, type AgentKind, type ModelOption } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronLeft, ChevronRight, Search, Zap } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { useColors } from "../ui/mode";
import { Text } from "../ui/Text";
import { useClaudeAccountChoice, useComposerModels } from "./claude-account";
import { ClaudeAccountMenu } from "./ClaudeAccountMenu";
import { AgentTabs } from "./AgentTabs";
import { sheetList, type SheetList, type SheetModel } from "./model-sheet-list";
import { recentModels, rememberModel } from "./recent-models";
import { useSharedSettings, type ComposerSettings } from "./settings-bridge";

function FastModeControl({ settings, state }: { settings: ComposerSettings | undefined; state: ReturnType<typeof pickerSettings> }) {
  const colors = useColors();
  const choice = settings?.choice;
  const { fast, fastAvailable, fastHint } = state;
  // Shown only where Fast can run, or while a saved request is on so it can be turned off.
  if (!fastAvailable && !fast) return null;
  return (
    <View className="gap-1">
      <View className="min-h-touch flex-row items-center gap-3">
        <Zap size={16} className="text-ink-3" />
        <Text className="flex-1 text-md">Fast mode</Text>
        <Switch
          accessibilityLabel="Fast mode"
          accessibilityHint={fastHint}
          value={fast}
          disabled={!settings || !choice}
          trackColor={{ false: colors["surface-3"], true: colors.ink }}
          thumbColor={fast ? colors.bg : colors["ink-4"]}
          ios_backgroundColor={colors["surface-3"]}
          onValueChange={(enabled) => {
            if (!settings || !choice || (enabled && !fastAvailable)) return;
            haptic.select();
            settings.selectModel({ ...choice, fastMode: enabled });
          }}
        />
      </View>
      {!fastAvailable ? <Text className="text-sm text-ink-4">{fastHint}</Text> : null}
    </View>
  );
}

function EffortControl({ settings, state }: { settings: ComposerSettings | undefined; state: ReturnType<typeof pickerSettings> }) {
  const choice = settings?.choice;
  const { efforts, effort } = state;
  return (
    <View className="gap-2">
      <Text className="text-sm text-ink-4">Effort</Text>
      <View className="flex-row rounded-full bg-surface-2 p-0.75">
        {efforts.map((level) => (
          <Pressable
            key={level}
            accessibilityRole="radio"
            accessibilityState={{ checked: level === effort }}
            onPress={() => {
              if (!settings || !choice || level === effort) return;
              haptic.select();
              settings.selectModel({ ...choice, effort: level });
            }}
            className={cn("min-h-touch flex-1 items-center justify-center rounded-full", level === effort && "bg-surface")}
          >
            <Text className={cn("text-sm text-ink-3", level === effort && "text-ink")}>{effortLabel(level)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ModelRow({ row, on, onPick }: { row: SheetModel; on: boolean; onPick: (model: ModelOption) => void }) {
  const { model, note } = row;
  return (
    <ListPressable
      accessibilityRole="radio"
      accessibilityLabel={model.label}
      accessibilityState={{ checked: on, disabled: Boolean(model.unavailable) }}
      disabled={Boolean(model.unavailable)}
      onPress={() => onPick(model)}
      className="min-h-touch flex-row items-center gap-3 rounded-md px-3 py-2 active:bg-surface-2"
    >
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className={cn("text-md", model.unavailable && "text-ink-4")}>
          {model.label}
        </Text>
        {model.unavailable || note ? <Text className="text-sm text-ink-4">{model.unavailable || note}</Text> : null}
      </View>
      {on ? <Check size={16} /> : null}
    </ListPressable>
  );
}

/** The tab picked here, else the chosen model's agent, else the first. */
function shownAgent(agents: AgentKind[], tab: AgentKind | null, choice: ModelChoice | null): AgentKind | null {
  if (tab && agents.includes(tab)) return tab;
  if (choice && agents.includes(choice.agent)) return choice.agent;
  return agents[0] ?? null;
}

function ProviderRow({ label, count, onOpen }: { label: string; count: number; onOpen: () => void }) {
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "model" : "models"}`}
      onPress={onOpen}
      className="min-h-touch flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
    >
      <Text numberOfLines={1} className="min-w-0 flex-1 text-md">
        {label}
      </Text>
      <Text className="text-sm text-ink-4">{count}</Text>
      <ChevronRight size={16} className="text-ink-4" />
    </ListPressable>
  );
}

const olderNote = (count: number) => `${count} older ${count === 1 ? "model is" : "models are"} hidden. Search to find them.`;

/** One agent's models as `sheetList` lays them out. */
function ModelList({ list, choice, onPick, onProvider }: { list: SheetList; choice: ModelChoice | null; onPick: (model: ModelOption) => void; onProvider: (provider: string | null) => void }) {
  const rows = (items: SheetModel[]) =>
    items.map((row) => <ModelRow key={`${row.model.agent}:${row.model.id}`} row={row} on={row.model.agent === choice?.agent && row.model.id === choice?.model} onPick={onPick} />);
  if (list.kind === "search" && !list.models.length) return <Text className="px-3 py-2 text-sm text-ink-4">No models match.</Text>;
  if (list.kind === "search" || list.kind === "all") return <View>{rows(list.models)}</View>;
  if (list.kind === "provider")
    return (
      <View>
        <ListPressable accessibilityRole="button" accessibilityLabel="All providers" onPress={() => onProvider(null)} className="min-h-touch flex-row items-center gap-1 px-1">
          <ChevronLeft size={16} className="text-ink-3" />
          <Text className="text-sm text-ink-3">All providers</Text>
        </ListPressable>
        <Label>{list.provider}</Label>
        {rows(list.models)}
        {list.olderHidden ? <Text className="px-3 pt-2 text-sm text-ink-4">{olderNote(list.olderHidden)}</Text> : null}
      </View>
    );
  return (
    <View>
      {list.suggested.length ? <Label>Suggested</Label> : null}
      {rows(list.suggested)}
      <Label>{list.providers.length ? "Providers" : "All models"}</Label>
      {list.providers.map(({ label, count }) => (
        <ProviderRow key={label} label={label} count={count} onOpen={() => onProvider(label)} />
      ))}
      {rows(list.models)}
    </View>
  );
}

const Label = ({ children }: { children: string }) => <Text className="px-3 pb-1 pt-3 text-xs text-ink-4">{children}</Text>;

function ModelStatus({ loading, error, empty }: { loading: boolean; error: Error | null; empty: boolean }) {
  if (loading) return <Text className="px-3 py-2 text-sm text-ink-4">Loading models…</Text>;
  if (error)
    return (
      <Text accessibilityRole="alert" className="px-3 py-2 text-sm text-ink-4">
        Couldn’t load models. {error.message}
      </Text>
    );
  return empty ? <Text className="px-3 py-2 text-sm text-ink-4">Enable an agent in Connections on your computer to choose a model.</Text> : null;
}

function ModelControls({ shown, settings, state }: { shown: AgentKind | null; settings: ComposerSettings | undefined; state: ReturnType<typeof pickerSettings> }) {
  if (shown && settings?.choice?.agent !== shown) return null;
  return (
    <>
      {state.efforts.length ? <EffortControl settings={settings} state={state} /> : null}
      <FastModeControl settings={settings} state={state} />
    </>
  );
}

/**
 * The models a composer can run, their effort and Fast mode, and on a Claude thread the account it runs on, once the
 * Mac has more than one. One agent's models show at a time. An agent with many, as OpenCode and Oh My Pi have, opens
 * on a short list of the current, recent and default models and a row per provider; a search looks through them all.
 */
export function ModelSheet() {
  const { composerId } = useLocalSearchParams<{ composerId: string }>();
  const insets = useSafeAreaInsets();
  const settings = useSharedSettings(composerId);
  const models = useComposerModels(settings);
  const account = useClaudeAccountChoice(settings);
  const catalog = pickerCatalog(models.data ?? []);
  const choice = settings?.choice ?? null;
  const current = catalogModel(models.data, choice);
  const state = pickerSettings({
    model: models.isPlaceholderData ? undefined : current,
    value: choice,
    loading: models.isLoading || models.isPlaceholderData,
    failed: Boolean(models.error),
  });
  const agents = [...new Set(catalog.filter((model) => !model.legacy).map((model) => model.agent))];
  const [tab, setTab] = useState<AgentKind | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(recentModels);
  const shown = shownAgent(agents, tab, choice);
  const list = shown ? sheetList({ catalog, agent: shown, choice, recents, query, provider }) : null;
  const pick = (model: ModelOption) => {
    if (!settings || model.unavailable) return;
    haptic.select();
    const picked = modelChoiceFor(model, choice);
    settings.selectModel(picked);
    rememberModel(picked);
    setRecents(recentModels());
  };
  return (
    <ScrollView
      className="flex-1 bg-bg"
      stickyHeaderIndices={[0]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
      onAccessibilityEscape={() => router.back()}
    >
      <View collapsable={false} className="gap-4 bg-bg px-5 pb-3 pt-6">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text accessibilityRole="header" className="text-xl">
            Model
          </Text>
          {shown ? (
            <Text className="text-sm text-ink-3" accessibilityLiveRegion="polite">
              {harnessShortName(shown)}
            </Text>
          ) : null}
        </View>
        {account && shown === "claude" ? <ClaudeAccountMenu choice={account} /> : null}
        {agents.length > 1 && shown ? (
          <AgentTabs
            agents={agents}
            shown={shown}
            onShow={(agent) => {
              setTab(agent);
              setProvider(null);
            }}
          />
        ) : null}
        <View className="h-touch flex-row items-center gap-2 rounded-full bg-surface px-4">
          <Search size={16} className="text-ink-4" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            placeholder={shown ? `Search ${harnessShortName(shown)} models` : "Search models"}
            placeholderTextColorClassName="accent-ink-4"
            accessibilityLabel="Search models"
            className="flex-1 p-0 font-sans text-md text-ink"
          />
        </View>
      </View>
      <View className="gap-5 px-5">
        <ModelStatus loading={models.isLoading} error={models.error} empty={!shown && !current} />
        {list ? <ModelList list={list} choice={choice} onPick={pick} onProvider={setProvider} /> : null}
        <ModelControls shown={shown} settings={settings} state={state} />
      </View>
    </ScrollView>
  );
}

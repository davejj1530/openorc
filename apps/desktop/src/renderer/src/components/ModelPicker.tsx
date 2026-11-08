import { Popover } from "@base-ui/react/popover";
import { browserModels, catalogModel, modelChoiceFor, pickerCatalog, pickerSettings, providerGroups, type ModelChoice } from "@openorc/client";
import {
  effortHint,
  effortLabel,
  harnessCatalog,
  harnessInfo,
  harnessInstalled,
  harnessLoggedIn,
  harnessName,
  isHarnessId,
  normalizeModelSettings,
  type HarnessId,
  type ModelOption,
  type Orcling,
} from "@openorc/protocol";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useClaudeAccountId } from "../lib/claude-account";
import { PickerAccountRows, warmAccountUsage, type PickerAccounts } from "./ModelPickerAccounts";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { useModelCatalog } from "../lib/use-model-catalog";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { HarnessLogo } from "./HarnessLogo";
import { Check, ChevronDown, Orcling as OrclingIcon, Plus, RotateCcw, Search, Zap } from "./icons";
import { BrowserEffortFooter, ComposerEffortPanel, fastStatus } from "./ModelPickerEffort";
import { OrclingRows, type OrclingPickerChoices } from "./ModelPickerRows";
import { OrclingAvatar } from "./OrclingAvatar";

export { defaultChoice, matchesQuery, multiProviderAgents, providerGroups } from "@openorc/client";
export type { ModelChoice } from "@openorc/client";
export type { OrclingPickerChoices } from "./ModelPickerRows";

/** The chosen model's name with the exact ID it pins, for tooltips. */
function modelTitle(current: ModelOption | undefined, model: string | undefined): string | undefined {
  return current ? `${current.label} · ${current.id}` : model;
}

type PickerSection = HarnessId | "orclings";

function initialPickerSection(orclings: OrclingPickerChoices | undefined, value: ModelChoice | null, enabled: readonly HarnessId[]): PickerSection {
  if (orclings?.selectedId) return "orclings";
  if (value && isHarnessId(value.agent) && enabled.includes(value.agent)) return value.agent;
  return enabled[0] ?? "orclings";
}

function enabledPickerSection(section: PickerSection, fallback: PickerSection, enabled: readonly HarnessId[]): PickerSection {
  return section === "orclings" || enabled.includes(section) ? section : fallback;
}

/** The Orcling a picker shows as chosen, if any. */
function chosenOrcling(orclings: OrclingPickerChoices | undefined): Orcling | null {
  return orclings?.selectedId ? (orclings.options.find((orcling) => orcling.id === orclings.selectedId) ?? null) : null;
}

function providerHint(status: ReturnType<typeof harnessInfo> | null): string | null {
  if (status && !harnessInstalled(status)) return "Not installed";
  if (status && !harnessLoggedIn(status)) return "Sign in";
  return null;
}

function modelRowMeta(model: ModelOption): ReactNode {
  if (model.unavailable) return <span className="model-picker-row-meta text-warn">{model.unavailable.split(/\.\s/)[0]}</span>;
  if (model.legacy) return <span className="model-picker-row-meta">legacy</span>;
  if (model.isDefault) return <span className="model-picker-row-meta">default</span>;
  return null;
}

function pickerTriggerIcon(value: ModelChoice | null, modelSize: number): ReactNode {
  if (value && isHarnessId(value.agent)) return <HarnessLogo id={value.agent} size={modelSize} />;
  return null;
}

/** A saved choice for a disabled agent asks for a new choice without changing the saved draft or thread. */
function useEnabledChoice(value: ModelChoice | null, harnesses?: readonly HarnessId[]): ModelChoice | null {
  const enabled = useEnabledHarnesses(harnesses);
  return value && isHarnessId(value.agent) && enabled.includes(value.agent) ? normalizeModelSettings(value) : null;
}

/** Keep the floating panel inside the conversation pane, including after a pane resize. */
function usePickerPopup() {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<Element>();
  const [maxWidth, setMaxWidth] = useState<number>();
  const trigger = useRef<HTMLButtonElement>(null);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    const element = trigger.current?.closest(".thread-pane") ?? trigger.current?.closest(".well") ?? undefined;
    setBoundary(element);
    const width = element?.getBoundingClientRect().width;
    setMaxWidth(width && width > 0 ? Math.max(0, width - 24) : undefined);
  };
  useLayoutEffect(() => {
    if (!open || !boundary || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = boundary.getBoundingClientRect().width;
      setMaxWidth(width > 0 ? Math.max(0, width - 24) : undefined);
    });
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [open, boundary]);
  return { open, setOpen, trigger, boundary, maxWidth, onOpenChange };
}

const SECTION_LABELS: Record<"orclings", string> = { orclings: "Orclings" };
const sectionLabel = (section: PickerSection) => (isHarnessId(section) ? `${harnessName(section)} models` : SECTION_LABELS[section]);

/** Arrow keys move between the picker's enabled rows; up from the first goes back to the search field. */
function moveRowFocusIn(event: KeyboardEvent<HTMLButtonElement>, results: HTMLElement | null, search: HTMLInputElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = [...(results?.querySelectorAll<HTMLButtonElement>("[data-picker-row]:not(:disabled)") ?? [])];
  const index = rows.indexOf(event.currentTarget);
  if (event.key === "ArrowDown") rows[index + 1]?.focus();
  else if (index > 0) rows[index - 1]?.focus();
  else search?.focus();
}

/** Search and effort stay fixed while the provider's model list scrolls. */
function ModelBrowser({
  value,
  onChange,
  onSelectModel = onChange,
  orclings,
  accounts,
  showEffort,
  showFast,
  disabled,
  closeOnSelect,
  close,
  harnesses,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  onSelectModel?: (choice: ModelChoice) => void;
  orclings?: OrclingPickerChoices;
  /** The Claude accounts to offer above Claude's models, with what each has left. */
  accounts?: PickerAccounts | undefined;
  showEffort: boolean;
  showFast: boolean;
  disabled?: boolean;
  closeOnSelect: boolean;
  close: () => void;
  harnesses?: readonly HarnessId[];
}) {
  const models = useModelCatalog();
  const enabled = useEnabledHarnesses(harnesses);
  const claudeAccountId = useClaudeAccountId();
  const system = useRpc("system.info", claudeAccountId ? { claudeAccountId } : {});
  const list = useMemo(() => pickerCatalog((models.data ?? []).filter((model) => isHarnessId(model.agent) && enabled.includes(model.agent))), [models.data, enabled]);
  const current = catalogModel(list, value);
  const [chosenSection, setSection] = useState<PickerSection>(() => initialPickerSection(orclings, value, enabled));
  const section = enabledPickerSection(chosenSection, initialPickerSection(orclings, value, enabled), enabled);
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const fastDescriptionId = useId();
  // An Orcling brings its own effort and Fast mode.
  const orclingSettings = Boolean(orclings?.selectedId);
  const harness = isHarnessId(section) ? section : null;
  const provider = harness && system.data ? harnessInfo(system.data, harness) : null;
  const ready = !harness || Boolean(provider && harnessLoggedIn(provider));
  const { legacy, searching, visible, multiProvider } = browserModels({ list, section: harness, query });
  const {
    efforts: effortOptions,
    defaultEffort,
    effort,
    effortIndex,
    fast,
    fastAvailable,
    fastBlocked,
    fastHint,
  } = pickerSettings({ model: current, value, loading: models.isPending, failed: models.isError });

  const switchSection = (next: PickerSection) => {
    setSection(next);
    setQuery("");
    setShowLegacy(false);
    if (results.current) results.current.scrollTop = 0;
  };
  const chooseModel = (model: ModelOption) => {
    onSelectModel(modelChoiceFor(model, value));
    if (closeOnSelect) close();
  };
  const moveRowFocus = (event: KeyboardEvent<HTMLButtonElement>) => moveRowFocusIn(event, results.current, search.current);
  const modelRow = (model: ModelOption, showProvider: boolean) => {
    const selected = !orclings?.selectedId && value?.agent === model.agent && value.model === model.id;
    return (
      <button
        key={`${model.agent}:${model.id}`}
        type="button"
        data-picker-row
        className="model-picker-row"
        aria-pressed={selected}
        title={model.unavailable ?? model.id}
        disabled={disabled || !ready || Boolean(model.unavailable)}
        onClick={() => chooseModel(model)}
        onKeyDown={moveRowFocus}
      >
        <span className="model-picker-row-name">{model.label}</span>
        {showProvider && model.provider && multiProvider.has(model.agent) ? <span className="model-picker-row-meta">{model.provider.label}</span> : null}
        {modelRowMeta(model)}
        {selected ? <Check size={15} className="model-picker-check" aria-hidden="true" /> : null}
      </button>
    );
  };

  // Fast shows only where it can run, or while a saved request is on so it can be turned off.
  const fastShown = showFast && !orclingSettings && (fastAvailable || fast);
  return (
    <div className="model-picker-layout">
      <Popover.Title className="sr-only">{showEffort ? "Model and effort" : "Choose a model"}</Popover.Title>
      <div className="model-picker-rail" role="group" aria-label="Model providers">
        {orclings ? (
          <button type="button" className="model-picker-rail-button" aria-label="Orclings" aria-pressed={section === "orclings"} title="Orclings" onClick={() => switchSection("orclings")}>
            <OrclingIcon size={20} />
          </button>
        ) : null}
        {enabled.map((id) => {
          const status = system.data ? harnessInfo(system.data, id) : null;
          const hint = providerHint(status);
          return (
            <button
              key={id}
              type="button"
              className="model-picker-rail-button"
              aria-label={`${harnessCatalog[id].name}${hint ? ` · ${hint}` : ""}`}
              aria-pressed={section === id}
              title={`${harnessCatalog[id].name}${hint ? ` · ${hint}` : ""}`}
              onClick={() => switchSection(id)}
            >
              <HarnessLogo id={id} size={20} />
            </button>
          );
        })}
        {fastShown ? (
          <button
            type="button"
            className="model-picker-rail-button model-picker-fast"
            aria-label="Fast mode"
            aria-pressed={fast}
            data-blocked={fastBlocked || undefined}
            aria-describedby={fastDescriptionId}
            title={`${fast ? "Turn off" : "Request"} Fast mode. ${fastHint}`}
            disabled={disabled || !value}
            onClick={() => {
              if (value) onChange({ ...value, fastMode: !fast });
            }}
          >
            <Zap size={20} />
          </button>
        ) : null}
        {fastShown ? (
          <span className="sr-only" id={fastDescriptionId}>
            {fastStatus(fast, fastBlocked)}
            {fastHint}
          </span>
        ) : null}
      </div>
      <div className="model-picker-main">
        <div className="model-picker-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={search}
            value={query}
            aria-label="Search models"
            placeholder="Search models"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                results.current?.querySelector<HTMLButtonElement>("[data-picker-row]:not(:disabled)")?.focus();
              }
            }}
          />
          <button type="button" aria-label="Refresh models" title="Refresh models" disabled={models.isFetching} onClick={() => void models.refreshModels()}>
            <RotateCcw size={15} />
          </button>
        </div>
        <div ref={results} className="model-picker-results" aria-label={sectionLabel(section)}>
          {models.providers
            .filter((item) => item.message && enabled.includes(item.agent))
            .map((item) => (
              <p key={item.agent} role="status" className="model-picker-message">
                {harnessName(item.agent)}: {item.message}
              </p>
            ))}
          {value && !current && models.data ? <p className="model-picker-message">Saved model: {value.model}. It is not in the current catalog; your selection is unchanged.</p> : null}
          {models.isFetching ? (
            <p role="status" className="model-picker-message">
              {models.data ? "Refreshing models…" : "Loading models…"}
            </p>
          ) : null}
          {models.isError && !models.isFetching ? (
            <div role="alert" className="model-picker-message">
              {models.data ? "Could not refresh models. Showing the last loaded list." : "Could not load models."}
              <button type="button" className="model-picker-text-action" onClick={() => void models.refreshModels()}>
                Retry loading models
              </button>
            </div>
          ) : null}

          {section === "orclings" ? <OrclingRows orclings={orclings} models={list} disabled={disabled} closeOnSelect={closeOnSelect} close={close} moveRowFocus={moveRowFocus} /> : null}
          {harness ? (
            <>
              {!ready && system.data ? (
                <p className="model-picker-message">
                  {provider && harnessInstalled(provider) ? `Sign in to ${harnessName(harness)} to use its models.` : `Install ${harnessName(harness)} to use its models.`}
                </p>
              ) : null}
              <PickerAccountRows section={harness} searching={searching} accounts={accounts} disabled={disabled} moveRowFocus={moveRowFocus} />
              {searching
                ? visible.map((model) => modelRow(model, true))
                : providerGroups(visible, harness).map(([label, group]) => (
                    <div key={label ?? "default"} className="model-picker-group">
                      {label ? <div className="model-picker-group-label">{label}</div> : null}
                      {group.map((model) => modelRow(model, false))}
                    </div>
                  ))}
              {!searching && legacy.length > 0 ? (
                <>
                  <button type="button" className="model-picker-text-action" aria-expanded={showLegacy} onClick={() => setShowLegacy(!showLegacy)}>
                    Legacy models · {legacy.length} <ChevronDown size={13} />
                  </button>
                  {showLegacy ? legacy.map((model) => modelRow(model, true)) : null}
                </>
              ) : null}
              {visible.length === 0 && !models.isFetching && !models.isError ? (
                <p className="model-picker-message">{searching ? "No models match." : `${harnessName(harness)} listed no models.`}</p>
              ) : null}
              <button type="button" className="model-picker-text-action model-picker-manage" onClick={() => useRouter.getState().navigate({ view: "settings" })}>
                <Plus size={14} /> Add providers
              </button>
            </>
          ) : null}
        </div>
        {showEffort && !orclingSettings ? (
          <BrowserEffortFooter
            value={value}
            current={current}
            onChange={onChange}
            disabled={disabled}
            efforts={effortOptions}
            index={effortIndex}
            effort={effort}
            defaultEffort={defaultEffort}
            fast={fast}
            fastBlocked={fastBlocked}
            fastHint={fastHint}
            loading={models.isPending}
            failed={models.isError}
          />
        ) : null}
      </div>
    </div>
  );
}

/** What the compact trigger shows after its label: the model a chosen Orcling runs on, or the chosen model's effort. */
function triggerDetail(orcling: Orcling | null, effort: string | null | undefined, models: ModelOption[] | undefined): string | null {
  if (orcling) return catalogModel(models, orcling.settings)?.label ?? orcling.settings.model;
  return effort ? effortLabel(effort) : null;
}

/** The picker trigger stays compact; the panel contains the complete selection flow. */
export function ModelPicker({
  value,
  onChange,
  disabled,
  showEffort = true,
  orclings,
  placeholder = "Choose a model",
  ariaLabel,
  harnesses,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean;
  showEffort?: boolean;
  orclings?: OrclingPickerChoices;
  placeholder?: string;
  ariaLabel?: string;
  harnesses?: readonly HarnessId[];
}) {
  const models = useModelCatalog();
  const popup = usePickerPopup();
  value = useEnabledChoice(value, harnesses);
  const current = catalogModel(models.data, value);
  const chosen = chosenOrcling(orclings);
  const selectedLabel = chosen?.name;
  const detail = triggerDetail(chosen, showEffort && !selectedLabel ? value?.effort : null, models.data);
  return (
    <Popover.Root
      open={popup.open}
      onOpenChange={(next) => {
        popup.onOpenChange(next);
        if (next) void models.refetch();
      }}
    >
      <Popover.Trigger
        ref={popup.trigger}
        disabled={disabled}
        aria-label={ariaLabel}
        title={selectedLabel ?? modelTitle(current, value?.model) ?? placeholder}
        className="inline-flex min-w-0 items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-md text-base text-ink-2 hover:bg-surface-2 hover:text-ink disabled:text-ink-4 disabled:pointer-events-none"
      >
        {chosen ? <OrclingAvatar orcling={chosen} size={14} /> : pickerTriggerIcon(value, 14)}
        <span className="truncate max-w-40">{selectedLabel ?? current?.label ?? value?.model ?? placeholder}</span>
        {detail ? <span className="model-effort shrink-0 text-ink-3 text-sm">{detail}</span> : null}
        <ChevronDown size={13} className="text-ink-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} collisionBoundary={popup.boundary}>
          <Popover.Popup className="model-picker-popup" initialFocus={false} data-no-effort={!showEffort || undefined} style={popup.maxWidth ? { maxWidth: popup.maxWidth } : undefined}>
            <ModelBrowser
              value={value}
              onChange={onChange}
              orclings={orclings}
              showEffort={showEffort}
              showFast={showEffort}
              disabled={disabled}
              harnesses={harnesses}
              closeOnSelect
              close={() => popup.setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The effort label holds the width of the model's longest one. The popup tracks the
 * trigger's size, so a label that grew and shrank with each step slid the popup sideways
 * while the effort slider was dragged.
 */
function TriggerEffort({ label, efforts }: { label: string; efforts: string[] }) {
  const others = [...new Set(efforts.map(effortLabel))].filter((other) => other !== label);
  return (
    <span className="composer-model-effort">
      <span>{label}</span>
      {others.map((other) => (
        <span key={other} aria-hidden="true">
          {other}
        </span>
      ))}
    </span>
  );
}

function ComposerTriggerIcon({ orcling, value }: { orcling: Orcling | null; value: ModelChoice | null }) {
  if (orcling) return <OrclingAvatar orcling={orcling} size={14} />;
  return <>{pickerTriggerIcon(value, 14)}</>;
}

/** A compact trigger with one model browser. */
export function ComposerModelPicker({
  value,
  onChange,
  onSelectModel,
  orclings,
  accounts,
  modelSelector,
  disabled,
  settingsDisabled = false,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  onSelectModel?: (choice: ModelChoice) => void;
  orclings?: OrclingPickerChoices;
  /** The Claude accounts the conversation can run on; the picker shows them with their usage and switches between them. */
  accounts?: PickerAccounts | undefined;
  modelSelector?: ReactNode;
  disabled?: boolean;
  settingsDisabled?: boolean;
}) {
  const models = useModelCatalog();
  const popup = usePickerPopup();
  value = useEnabledChoice(value);
  const current = catalogModel(models.data, value);
  const {
    efforts,
    defaultEffort,
    effort,
    effortIndex: index,
    fast,
    fastAvailable,
    fastBlocked,
    fastHint,
  } = pickerSettings({ model: current, value, loading: models.isPending, failed: models.isError });
  const label = effort ? effortLabel(effort) : "Default";
  const hint = effortHint(effort);
  const title = `${modelTitle(current, value?.model) ?? "Choose a model"} · ${label}`;
  return (
    <Popover.Root
      open={popup.open}
      onOpenChange={(next) => {
        popup.onOpenChange(next);
        if (next) void models.refetch();
      }}
    >
      <Popover.Trigger
        ref={popup.trigger}
        disabled={disabled}
        className="composer-model-trigger"
        aria-label="Model and effort"
        {...warmAccountUsage(accounts)}
        title={fast && fastBlocked ? `${title} · ${fastStatus(fast, fastBlocked)}${fastHint}` : title}
      >
        <ComposerTriggerIcon orcling={chosenOrcling(orclings)} value={value} />
        {fast ? <Zap size={13} aria-label={fastBlocked ? "Fast mode can't run" : "Fast mode requested"} className="composer-fast-indicator shrink-0" data-blocked={fastBlocked || undefined} /> : null}
        <span className="composer-model-name">{chosenOrcling(orclings)?.name ?? current?.label ?? value?.model ?? "Choose model"}</span>
        {value ? <TriggerEffort label={label} efforts={efforts} /> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} collisionBoundary={popup.boundary}>
          <Popover.Popup
            ref={floatingGround}
            className={cn(modelSelector ? "composer-effort-popup" : "model-picker-popup", "composer-float")}
            initialFocus={modelSelector ? undefined : false}
            style={popup.maxWidth ? { maxWidth: popup.maxWidth } : undefined}
          >
            {modelSelector ? (
              <ComposerEffortPanel
                value={value}
                current={current}
                onChange={onChange}
                disabled={settingsDisabled}
                efforts={efforts}
                index={index}
                label={label}
                defaultEffort={defaultEffort}
                fast={fast}
                fastAvailable={fastAvailable}
                fastBlocked={fastBlocked}
                fastHint={fastHint}
                hint={hint}
                loading={models.isPending}
                failed={models.isError}
              >
                {modelSelector}
              </ComposerEffortPanel>
            ) : (
              <ModelBrowser
                value={value}
                onChange={onChange}
                onSelectModel={onSelectModel}
                orclings={orclings}
                accounts={accounts}
                showEffort
                showFast
                disabled={settingsDisabled}
                closeOnSelect={false}
                close={() => popup.setOpen(false)}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

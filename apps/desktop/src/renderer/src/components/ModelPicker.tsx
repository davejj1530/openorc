import { useModelCatalog } from "../lib/use-model-catalog";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { effortHint, effortLabel, normalizeModelSettings } from "@openorc/protocol";
import { harnessCatalog, harnessIds, harnessInfo, harnessInstalled, harnessLoggedIn, harnessName, isHarnessId, type HarnessId, type ModelOption, type Orcling } from "@openorc/protocol";
import { Check, ChevronDown, Orcling as OrclingIcon, Plus, Search, Workflow, RotateCcw, Zap } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { Popover } from "@base-ui/react/popover";
import { useRpc } from "../lib/query";
import { useRouter } from "../lib/router";
import { HarnessLogo } from "./HarnessLogo";
import { CoversPreview } from "../lib/browser-preview";
import { BrowserEffortFooter, ComposerEffortPanel, fastStatus, orclingLed, type EffortTeam } from "./ModelPickerEffort";
import { OrclingRows, TeamRows, type OrclingPickerChoices, type TeamPickerChoices } from "./ModelPickerRows";
import { browserModels, catalogModel, modelChoiceFor, pickerCatalog, pickerSettings, providerGroups, type ModelChoice } from "../lib/model-picker-selection";

export { defaultChoice, matchesQuery, multiProviderAgents, providerGroups } from "../lib/model-picker-selection";
export type { ModelChoice } from "../lib/model-picker-selection";
export type { OrclingPickerChoices, TeamPickerChoices, TeamPickerOption } from "./ModelPickerRows";

/** The chosen model's name with the exact ID it pins, for tooltips. */
function modelTitle(current: ModelOption | undefined, model: string | undefined): string | undefined {
  return current ? `${current.label} · ${current.id}` : model;
}

type PickerSection = HarnessId | "teams" | "orclings";

function initialPickerSection(teams: TeamPickerChoices | undefined, orclings: OrclingPickerChoices | undefined, value: ModelChoice | null): PickerSection {
  if (teams?.selectedLabel) return "teams";
  if (orclings?.selectedId) return "orclings";
  if (value && isHarnessId(value.agent)) return value.agent;
  return harnessIds[0]!;
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

function pickerTriggerIcon(teamSelected: boolean, value: ModelChoice | null, teamSize: number, modelSize: number): ReactNode {
  if (teamSelected) return <Workflow size={teamSize} className={teamSize === 13 ? "shrink-0" : undefined} />;
  if (value && isHarnessId(value.agent)) return <HarnessLogo id={value.agent} size={modelSize} />;
  return null;
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

const SECTION_LABELS: Record<"teams" | "orclings", string> = { teams: "Project teams", orclings: "Orclings" };
const sectionLabel = (section: PickerSection) => (isHarnessId(section) ? `${harnessName(section)} models` : SECTION_LABELS[section]);

/** Search and effort stay fixed while the provider's model list scrolls. */
function ModelBrowser({
  value,
  onChange,
  onSelectModel = onChange,
  teams,
  orclings,
  team,
  showEffort,
  showFast,
  disabled,
  closeOnSelect,
  close,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  onSelectModel?: (choice: ModelChoice) => void;
  teams?: TeamPickerChoices;
  orclings?: OrclingPickerChoices;
  team?: EffortTeam;
  showEffort: boolean;
  showFast: boolean;
  disabled?: boolean;
  closeOnSelect: boolean;
  close: () => void;
}) {
  const models = useModelCatalog();
  const system = useRpc("system.info", {});
  const list = useMemo(() => pickerCatalog(models.data ?? []), [models.data]);
  const current = catalogModel(list, value);
  const [section, setSection] = useState<PickerSection>(() => initialPickerSection(teams, orclings, value));
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const fastDescriptionId = useId();
  // An Orcling, chosen or leading the chosen team, brings its own effort and Fast mode.
  const orclingSettings = Boolean(orclings?.selectedId) || orclingLed(team);
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
  } = pickerSettings({
    model: current,
    value,
    loading: models.isPending,
    failed: models.isError,
  });

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
  const moveRowFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(results.current?.querySelectorAll<HTMLButtonElement>("[data-picker-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") rows[index + 1]?.focus();
    else if (index > 0) rows[index - 1]?.focus();
    else search.current?.focus();
  };
  const modelRow = (model: ModelOption, showProvider: boolean) => {
    const selected = !teams?.selectedLabel && !orclings?.selectedId && value?.agent === model.agent && value.model === model.id;
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

  return (
    <div className="model-picker-layout">
      <Popover.Title className="sr-only">{showEffort ? "Model and effort" : "Choose a model"}</Popover.Title>
      <div className="model-picker-rail" role="group" aria-label="Model providers">
        {orclings ? (
          <button type="button" className="model-picker-rail-button" aria-label="Orclings" aria-pressed={section === "orclings"} title="Orclings" onClick={() => switchSection("orclings")}>
            <OrclingIcon size={20} />
          </button>
        ) : null}
        {teams ? (
          <button type="button" className="model-picker-rail-button" aria-label="Project teams" aria-pressed={section === "teams"} title="Project teams" onClick={() => switchSection("teams")}>
            <Workflow size={19} />
          </button>
        ) : null}
        {harnessIds.map((id) => {
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
        {showFast && !orclingSettings ? (
          <button
            type="button"
            className="model-picker-rail-button model-picker-fast"
            aria-label={team ? "Lead Fast mode" : "Fast mode"}
            aria-pressed={fast}
            data-blocked={fastBlocked || undefined}
            aria-describedby={fastDescriptionId}
            title={`${fast ? "Turn off" : "Request"} Fast mode. ${fastHint}`}
            disabled={disabled || !value || (!fastAvailable && !fast)}
            onClick={() => {
              if (value) onChange({ ...value, fastMode: !fast });
            }}
          >
            <Zap size={20} />
          </button>
        ) : null}
        {showFast && !orclingSettings ? (
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
            .filter((item) => item.message)
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
          {section === "teams" ? <TeamRows teams={teams} disabled={disabled} closeOnSelect={closeOnSelect} close={close} moveRowFocus={moveRowFocus} /> : null}
          {section === "orclings" ? <OrclingRows orclings={orclings} models={list} disabled={disabled} closeOnSelect={closeOnSelect} close={close} moveRowFocus={moveRowFocus} /> : null}
          {harness ? (
            <>
              {!ready && system.data ? (
                <p className="model-picker-message">
                  {provider && harnessInstalled(provider) ? `Sign in to ${harnessName(harness)} to use its models.` : `Install ${harnessName(harness)} to use its models.`}
                </p>
              ) : null}
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
            team={team}
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
  teams,
  orclings,
  placeholder = "Choose a model",
  ariaLabel,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean;
  showEffort?: boolean;
  teams?: TeamPickerChoices;
  orclings?: OrclingPickerChoices;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const models = useModelCatalog();
  const popup = usePickerPopup();
  value = value ? normalizeModelSettings(value) : null;
  const current = catalogModel(models.data, value);
  const chosen = chosenOrcling(orclings);
  const selectedLabel = chosen?.name ?? teams?.selectedLabel;
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
        {chosen ? <OrclingAvatar orcling={chosen} size={14} /> : pickerTriggerIcon(Boolean(teams?.selectedLabel), value, 13, 14)}
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
              teams={teams}
              orclings={orclings}
              showEffort={showEffort}
              showFast={showEffort}
              disabled={disabled}
              closeOnSelect
              close={() => popup.setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ComposerTriggerIcon({ orcling, team, value }: { orcling: Orcling | null; team: boolean; value: ModelChoice | null }) {
  if (orcling) return <OrclingAvatar orcling={orcling} size={14} />;
  return <>{pickerTriggerIcon(team, value, 14, 14)}</>;
}

/** A compact trigger with one model browser, or lead settings when a team is already running. */
export function ComposerModelPicker({
  value,
  onChange,
  onSelectModel,
  team,
  teams,
  orclings,
  modelSelector,
  disabled,
  settingsDisabled = false,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  onSelectModel?: (choice: ModelChoice) => void;
  team?: EffortTeam;
  teams?: TeamPickerChoices;
  orclings?: OrclingPickerChoices;
  modelSelector?: ReactNode;
  disabled?: boolean;
  settingsDisabled?: boolean;
}) {
  const models = useModelCatalog();
  const popup = usePickerPopup();
  const current = catalogModel(models.data, value);
  value = value ? normalizeModelSettings(value) : null;
  const {
    efforts,
    defaultEffort,
    effort,
    effortIndex: index,
    fast,
    fastAvailable,
    fastBlocked,
    fastHint,
  } = pickerSettings({
    model: current,
    value,
    loading: models.isPending,
    failed: models.isError,
  });
  const label = effort ? effortLabel(effort) : "Default";
  const hint = effortHint(effort);
  const title = team ? `${team.name} · Version ${team.revision} · ${team.leadName}: ${label}` : `${modelTitle(current, value?.model) ?? "Choose a model"} · ${label}`;
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
        aria-label={team ? "Team and lead effort" : "Model and effort"}
        title={fast && fastBlocked ? `${title} · ${fastStatus(fast, fastBlocked)}${fastHint}` : title}
      >
        <ComposerTriggerIcon orcling={chosenOrcling(orclings)} team={Boolean(team)} value={value} />
        {fast ? <Zap size={13} aria-label={fastBlocked ? "Fast mode can't run" : "Fast mode requested"} className="composer-fast-indicator shrink-0" data-blocked={fastBlocked || undefined} /> : null}
        <span className="composer-model-name">{chosenOrcling(orclings)?.name ?? team?.name ?? current?.label ?? value?.model ?? "Choose model"}</span>
        {value ? <span className="composer-model-effort">{label}</span> : null}
        <ChevronDown size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="end" sideOffset={10} collisionPadding={12} collisionBoundary={popup.boundary}>
          <Popover.Popup
            className={modelSelector ? "composer-effort-popup" : "model-picker-popup"}
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
                team={team}
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
                team={team}
                teams={teams}
                orclings={orclings}
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

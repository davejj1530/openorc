import { useModelCatalog } from "../lib/use-model-catalog";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ULTRACODE_EFFORT, effortHint, effortLabel, normalizeModelSettings } from "@openorc/protocol";
import { harnessCatalog, harnessIds, harnessInfo, harnessInstalled, harnessLoggedIn, harnessName, isHarnessId, type AgentKind, type HarnessId, type ModelOption } from "@openorc/protocol";
import { Check, ChevronDown, Plus, Search, Workflow, RotateCcw, Zap } from "./icons";
import { Popover } from "@base-ui/react/popover";
import { FastModeRocket } from "./FastModeRocket";
import { EffortGalaxy } from "./EffortGalaxy";
import { useRpc } from "../lib/query";
import { useRouter } from "../lib/router";
import { HarnessLogo } from "./HarnessLogo";
import { CoversPreview } from "../lib/browser-preview";
import { Select } from "./ui";
import { browserModels, catalogModel, modelChoiceFor, pickerCatalog, pickerSettings, providerGroups, type ModelChoice } from "../lib/model-picker-selection";

export { defaultChoice, matchesQuery, multiProviderAgents, providerGroups } from "../lib/model-picker-selection";
export type { ModelChoice } from "../lib/model-picker-selection";

export interface TeamPickerOption {
  teamId: string;
  revisionId: string;
  name: string;
  revision: number;
  memberCount: number;
  disabledReason?: string | null;
}

export interface TeamPickerChoices {
  options: TeamPickerOption[];
  selectedRevisionId?: string;
  selectedLabel?: string;
  onSelect: (revisionId: string) => void;
  status?: ReactNode;
  action?: { label: string; onSelect: () => void };
}

/** The chosen model's name with the exact ID it pins, for tooltips. */
function modelTitle(current: ModelOption | undefined, model: string | undefined): string | undefined {
  return current ? `${current.label} · ${current.id}` : model;
}

/** How the Fast description opens: silent when Fast is off, and a request the catalog says cannot run is not called requested. */
function fastStatus(fast: boolean, blocked: boolean): string {
  if (!fast) return "";
  return blocked ? "Fast can't run. " : "Fast requested. ";
}

type PickerSection = HarnessId | "teams";

function initialPickerSection(teams: TeamPickerChoices | undefined, value: ModelChoice | null): PickerSection {
  if (teams?.selectedLabel) return "teams";
  if (value && isHarnessId(value.agent)) return value.agent;
  return harnessIds[0]!;
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

/** Search and effort stay fixed while the provider's model list scrolls. */
function ModelBrowser({
  value,
  onChange,
  onSelectModel = onChange,
  teams,
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
  team?: { name: string; revision: number; leadName: string };
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
  const [section, setSection] = useState<PickerSection>(() => initialPickerSection(teams, value));
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const fastDescriptionId = useId();
  const provider = section !== "teams" && system.data ? harnessInfo(system.data, section) : null;
  const ready = section === "teams" || Boolean(provider && harnessLoggedIn(provider));
  const { legacy, searching, visible, multiProvider } = browserModels({ list, section, query });
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
    const selected = !teams?.selectedLabel && value?.agent === model.agent && value.model === model.id;
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
        {showFast ? (
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
        {showFast ? (
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
        <div ref={results} className="model-picker-results" aria-label={section === "teams" ? "Project teams" : `${harnessName(section)} models`}>
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
          {section === "teams" ? (
            <>
              {teams?.options.map((option) => (
                <button
                  key={option.revisionId}
                  type="button"
                  data-picker-row
                  className="model-picker-row model-picker-team-row"
                  aria-pressed={teams.selectedRevisionId === option.revisionId}
                  disabled={disabled || Boolean(option.disabledReason)}
                  title={option.disabledReason ?? `${option.memberCount} agents · Revision ${option.revision}`}
                  onClick={() => {
                    teams.onSelect(option.revisionId);
                    if (closeOnSelect) close();
                  }}
                  onKeyDown={moveRowFocus}
                >
                  <span className="model-picker-row-name">{option.name}</span>
                  <span className="model-picker-row-meta">{option.disabledReason ?? `${option.memberCount} agents · Revision ${option.revision}`}</span>
                  {teams.selectedRevisionId === option.revisionId ? <Check size={15} className="model-picker-check" aria-hidden="true" /> : null}
                </button>
              ))}
              {teams?.status ? (
                <p role="status" className="model-picker-message">
                  {teams.status}
                </p>
              ) : null}
              {teams?.action ? (
                <button type="button" className="model-picker-text-action" onClick={teams.action.onSelect}>
                  {teams.action.label}
                </button>
              ) : null}
            </>
          ) : (
            <>
              {!ready && system.data ? (
                <p className="model-picker-message">
                  {provider && harnessInstalled(provider) ? `Sign in to ${harnessName(section)} to use its models.` : `Install ${harnessName(section)} to use its models.`}
                </p>
              ) : null}
              {searching
                ? visible.map((model) => modelRow(model, true))
                : providerGroups(visible, section).map(([label, group]) => (
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
                <p className="model-picker-message">{searching ? "No models match." : `${harnessName(section)} listed no models.`}</p>
              ) : null}
              <button type="button" className="model-picker-text-action model-picker-manage" onClick={() => useRouter.getState().navigate({ view: "settings" })}>
                <Plus size={14} /> Add providers
              </button>
            </>
          )}
        </div>
        {showEffort ? (
          <div className="model-picker-footer">
            <div className="model-picker-effort-heading">
              <span>Reasoning effort</span>
              <span className="model-picker-effort-value">{effort ? effortLabel(effort) : "Default"}</span>
              <button
                type="button"
                className="model-picker-reset"
                aria-label="Reset effort to model default"
                title="Reset to model default"
                disabled={disabled || !value || !current || value.effort === defaultEffort}
                onClick={() => {
                  if (value && current) onChange({ ...value, effort: defaultEffort });
                }}
              >
                <RotateCcw size={14} />
              </button>
            </div>
            {effortOptions.length > 1 && value ? (
              <EffortControl
                key={`${value.agent}:${value.model}`}
                agent={value.agent}
                efforts={effortOptions}
                fast={fast && !fastBlocked}
                disabled={disabled}
                value={effortIndex}
                onChange={(next) => {
                  const selected = effortOptions[next];
                  if (selected && selected !== value.effort) onChange({ ...value, effort: selected });
                }}
              />
            ) : (
              <p className="model-picker-effort-empty">{effortAvailability(current, Boolean(value), models.isPending, models.isError)}</p>
            )}
            {effortHint(effort) ? <p className="model-picker-effort-hint">{effortHint(effort)}</p> : null}
            {fast && fastBlocked ? (
              <p className="model-picker-effort-hint">
                {fastStatus(fast, fastBlocked)}
                {fastHint}
              </p>
            ) : null}
            {team ? <p className="model-picker-effort-hint">Effort and Fast apply to {team.leadName}, this task’s lead.</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The picker trigger stays compact; the panel contains the complete selection flow. */
export function ModelPicker({
  value,
  onChange,
  disabled,
  showEffort = true,
  teams,
  placeholder = "Choose a model",
  ariaLabel,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean;
  showEffort?: boolean;
  teams?: TeamPickerChoices;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const models = useModelCatalog();
  const popup = usePickerPopup();
  value = value ? normalizeModelSettings(value) : null;
  const current = catalogModel(models.data, value);
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
        title={teams?.selectedLabel ?? modelTitle(current, value?.model) ?? placeholder}
        className="inline-flex min-w-0 items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-md text-base text-ink-2 hover:bg-surface-2 hover:text-ink disabled:text-ink-4 disabled:pointer-events-none"
      >
        {pickerTriggerIcon(Boolean(teams?.selectedLabel), value, 13, 14)}
        <span className="truncate max-w-40">{teams?.selectedLabel ?? current?.label ?? value?.model ?? placeholder}</span>
        {showEffort && !teams?.selectedLabel && value?.effort ? <span className="model-effort shrink-0 text-ink-3 text-sm">{effortLabel(value.effort)}</span> : null}
        <ChevronDown size={13} className="text-ink-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} collisionBoundary={popup.boundary}>
          <Popover.Popup className="model-picker-popup" initialFocus={false} data-no-effort={!showEffort || undefined} style={popup.maxWidth ? { maxWidth: popup.maxWidth } : undefined}>
            <ModelBrowser value={value} onChange={onChange} teams={teams} showEffort={showEffort} showFast={showEffort} disabled={disabled} closeOnSelect close={() => popup.setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A compact trigger with one model browser, or lead settings when a team is already running. */
export function ComposerModelPicker({
  value,
  onChange,
  onSelectModel,
  team,
  teams,
  modelSelector,
  disabled,
  settingsDisabled = false,
}: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  onSelectModel?: (choice: ModelChoice) => void;
  team?: { name: string; revision: number; leadName: string };
  teams?: TeamPickerChoices;
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
  const fastDescriptionId = useId();
  const title = team ? `${team.name} · Revision ${team.revision} · ${team.leadName}: ${label}` : `${modelTitle(current, value?.model) ?? "Choose a model"} · ${label}`;
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
        {pickerTriggerIcon(Boolean(team), value, 14, 14)}
        {fast ? <Zap size={13} aria-label={fastBlocked ? "Fast mode can't run" : "Fast mode requested"} className="composer-fast-indicator shrink-0" data-blocked={fastBlocked || undefined} /> : null}
        <span className="composer-model-name">{team?.name ?? current?.label ?? value?.model ?? "Choose model"}</span>
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
              <>
                <div className="composer-effort-heading">
                  <button
                    type="button"
                    className="composer-icon-button composer-fast-toggle"
                    aria-label={team ? "Lead Fast mode" : "Fast mode"}
                    aria-pressed={fast}
                    data-blocked={fastBlocked || undefined}
                    aria-describedby={fastDescriptionId}
                    title={`${fast ? "Turn off" : "Request"} Fast mode. ${fastHint}`}
                    disabled={settingsDisabled || !value || (!fastAvailable && !fast)}
                    onClick={() => {
                      if (value) onChange({ ...value, fastMode: !fast });
                    }}
                  >
                    <Zap size={18} />
                  </button>
                  <Popover.Title className="composer-effort-title">{label}</Popover.Title>
                  <button
                    type="button"
                    className="composer-icon-button"
                    aria-label="Reset effort to model default"
                    title="Reset to model default"
                    disabled={settingsDisabled || !value || !current || value.effort === defaultEffort}
                    onClick={() => {
                      if (value && current) onChange({ ...value, effort: defaultEffort });
                    }}
                  >
                    <RotateCcw size={17} />
                  </button>
                </div>
                <div className="composer-effort-model">{modelSelector}</div>
                {team ? (
                  <p className="text-xs text-ink-3 text-center mt-2">
                    {team.leadName} · Revision {team.revision}
                    <br />
                    Effort and Fast apply to this task’s lead.
                  </p>
                ) : null}
                {efforts.length > 1 && value ? (
                  <EffortControl
                    key={`${value.agent}:${value.model}`}
                    agent={value.agent}
                    efforts={efforts}
                    fast={fast && !fastBlocked}
                    disabled={settingsDisabled}
                    value={index}
                    onChange={(next) => {
                      const selected = efforts[next];
                      if (selected && selected !== value.effort) onChange({ ...value, effort: selected });
                    }}
                  />
                ) : (
                  <p className="text-xs text-ink-3 text-center mt-3">{effortAvailability(current, Boolean(value), models.isPending, models.isError)}</p>
                )}
                {hint ? <p className="composer-effort-hint">{hint}</p> : null}
                <Popover.Description id={fastDescriptionId} className="composer-fast-description">
                  {fastStatus(fast, fastBlocked)}
                  {fastHint}
                </Popover.Description>
              </>
            ) : (
              <ModelBrowser
                value={value}
                onChange={onChange}
                onSelectModel={onSelectModel}
                team={team}
                teams={teams}
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

function effortAvailability(model: ModelOption | undefined, selected: boolean, loading: boolean, failed: boolean): string {
  if (model?.unavailable) return model.unavailable;
  if (loading) return "Loading effort options…";
  if (failed) return "Could not load effort options. Try Refresh models.";
  if (!model) return selected ? "Effort options are unavailable for the selected model. Try Refresh models." : "Choose a model to adjust its effort.";
  return model.efforts.length === 1 ? "This connection offers one effort option for this model." : "This connection does not advertise adjustable effort options for this model.";
}

type EffortControlProps = { efforts: string[]; value: number; fast: boolean; onChange: (index: number) => void; disabled?: boolean };

function EffortControl({ agent, ...props }: EffortControlProps & { agent: AgentKind }) {
  // Named variants and an unresolved default have no honest position on a
  // low-to-high scale. Preserve the advertised choices without ranking them.
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", ULTRACODE_EFFORT];
  const ordered = props.efforts.every((effort, index) => levels.includes(effort) && (index === 0 || levels.indexOf(effort) > levels.indexOf(props.efforts[index - 1]!)));
  if (agent === "opencode" || props.value < 0 || !ordered) {
    return (
      <Select className="w-full mt-3" aria-label="Reasoning effort" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(Number(event.target.value))}>
        {props.value < 0 ? (
          <option value={-1} disabled>
            Choose an effort
          </option>
        ) : null}
        {props.efforts.map((effort, index) => (
          <option key={effort} value={index}>
            {effortLabel(effort)}
          </option>
        ))}
      </Select>
    );
  }
  return <EffortSlider {...props} />;
}

function EffortSlider({ efforts, value, fast, onChange, disabled }: EffortControlProps) {
  const [position, setPosition] = useState<number | null>(null);
  const drag = useRef<{ id: number; initial: number; offset: number } | null>(null);
  const flight = useRef<HTMLDivElement>(null);
  const max = efforts.length - 1;
  const fraction = (position ?? value) / max;
  // Keep the whole active thumb inside the track, including the wider rocket.
  const thumbInset = fast ? 32 : 14;
  const style = { "--effort-center": `calc(${fraction * 100}% + ${thumbInset * (1 - 2 * fraction)}px)` } as CSSProperties;
  const finishLaunch = () =>
    flight.current
      ?.querySelector(".fast-mode-rocket")
      ?.getAnimations()
      .forEach((animation) => animation.finish());
  const move = (event: PointerEvent<HTMLInputElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const next = Math.max(0, Math.min(max, ((event.clientX - rect.left - thumbInset - (drag.current?.offset ?? 0)) / Math.max(1, rect.width - 2 * thumbInset)) * max));
    setPosition(next);
    onChange(Math.round(next));
  };
  const finish = (event: PointerEvent<HTMLInputElement>, cancel = false) => {
    if (drag.current?.id !== event.pointerId) return;
    if (cancel) onChange(drag.current.initial);
    else move(event);
    drag.current = null;
    setPosition(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className="composer-effort-slider"
      data-fast={fast || undefined}
      data-max={value === max || undefined}
      data-ultracode={efforts[value] === ULTRACODE_EFFORT || undefined}
      data-dragging={position !== null || undefined}
      style={style}
    >
      <div className="composer-effort-fill" aria-hidden="true">
        {value === max ? <EffortGalaxy /> : null}
      </div>
      <div className="composer-effort-ticks" aria-hidden="true">
        {efforts.map((e) => (
          // Ultracode is a mode on top of the levels, so its stop sits apart from them.
          <i key={e} data-detached={e === ULTRACODE_EFFORT || undefined} />
        ))}
      </div>
      {fast ? (
        <div ref={flight} className="fast-mode-flight" aria-hidden="true">
          <FastModeRocket />
        </div>
      ) : (
        <div className="composer-effort-thumb" aria-hidden="true" />
      )}
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label="Reasoning effort"
        aria-valuetext={effortLabel(efforts[value] ?? "default")}
        onChange={(event) => {
          finishLaunch();
          onChange(Number(event.target.value));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          // Grabbing the control takes over immediately, even during the launch.
          finishLaunch();
          const rect = event.currentTarget.getBoundingClientRect();
          const distance = event.clientX - (rect.left + thumbInset + (value / max) * (rect.width - 2 * thumbInset));
          drag.current = { id: event.pointerId, initial: value, offset: Math.abs(distance) <= thumbInset ? distance : 0 };
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event);
        }}
        onPointerMove={(event) => {
          if (drag.current?.id === event.pointerId) move(event);
        }}
        onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)}
        onLostPointerCapture={() => {
          drag.current = null;
          setPosition(null);
        }}
      />
    </div>
  );
}

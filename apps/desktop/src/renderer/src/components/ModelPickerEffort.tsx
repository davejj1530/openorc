import { useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ULTRACODE_EFFORT, effortHint, effortLabel, type AgentKind, type ModelOption } from "@openorc/protocol";
import type { ModelChoice } from "../lib/model-picker-selection";
import { EffortGalaxy } from "./EffortGalaxy";
import { FastModeRocket } from "./FastModeRocket";
import { RotateCcw, Zap } from "./icons";
import { Select } from "./ui";

/** How the Fast description opens: silent when Fast is off, and a request the catalog says cannot run is not called requested. */
export function fastStatus(fast: boolean, blocked: boolean): string {
  if (!fast) return "";
  return blocked ? "Fast can't run. " : "Fast requested. ";
}

/** The team whose lead the effort and Fast settings apply to. */
export interface EffortTeam {
  name: string;
  revision: number;
  leadName: string;
  /** The Orcling leading the team, by name. It keeps its own model, effort and Fast mode. */
  leadOrcling?: string | undefined;
}

/** Whether an Orcling leads the team, so its effort and Fast mode stay its own. */
export function orclingLed(team: EffortTeam | undefined): boolean {
  return Boolean(team?.leadOrcling);
}

/** What a picker knows about the chosen model's effort and Fast settings. */
interface EffortSettings {
  value: ModelChoice | null;
  current: ModelOption | undefined;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean | undefined;
  efforts: string[];
  index: number;
  defaultEffort: string | null;
  fast: boolean;
  fastBlocked: boolean;
  fastHint: string;
  team?: EffortTeam | undefined;
  loading: boolean;
  failed: boolean;
}

/** The model browser's effort footer, below the model list. */
export function BrowserEffortFooter({
  value,
  current,
  onChange,
  disabled,
  efforts,
  index,
  effort,
  defaultEffort,
  fast,
  fastBlocked,
  fastHint,
  team,
  loading,
  failed,
}: EffortSettings & { effort: string | null }) {
  return (
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
      {efforts.length > 1 && value ? (
        <EffortControl
          key={`${value.agent}:${value.model}`}
          agent={value.agent}
          efforts={efforts}
          fast={fast && !fastBlocked}
          disabled={disabled}
          value={index}
          onChange={(next) => {
            const selected = efforts[next];
            if (selected && selected !== value.effort) onChange({ ...value, effort: selected });
          }}
        />
      ) : (
        <p className="model-picker-effort-empty">{effortAvailability(current, Boolean(value), loading, failed)}</p>
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
  );
}

/** The composer's effort popup: Fast, reset and the effort control around the model selector. */
export function ComposerEffortPanel({
  value,
  current,
  onChange,
  disabled,
  efforts,
  index,
  label,
  defaultEffort,
  fast,
  fastAvailable,
  fastBlocked,
  fastHint,
  hint,
  team,
  loading,
  failed,
  children,
}: EffortSettings & { label: string; fastAvailable: boolean; hint: string | null; children: ReactNode }) {
  const fastDescriptionId = useId();
  // Nothing changes without a model, and an Orcling lead keeps its own effort and Fast mode.
  const fixed = disabled || !value || orclingLed(team);
  return (
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
          disabled={fixed || (!fastAvailable && !fast)}
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
          disabled={fixed || !current || value?.effort === defaultEffort}
          onClick={() => {
            if (value && current) onChange({ ...value, effort: defaultEffort });
          }}
        >
          <RotateCcw size={17} />
        </button>
      </div>
      <div className="composer-effort-model">{children}</div>
      {team ? <TeamLeadNote team={team} /> : null}
      {efforts.length > 1 && value ? (
        <EffortControl
          key={`${value.agent}:${value.model}`}
          agent={value.agent}
          efforts={efforts}
          fast={fast && !fastBlocked}
          disabled={fixed}
          value={index}
          onChange={(next) => {
            const selected = efforts[next];
            if (selected && selected !== value.effort) onChange({ ...value, effort: selected });
          }}
        />
      ) : (
        <p className="text-xs text-ink-3 text-center mt-3">{effortAvailability(current, Boolean(value), loading, failed)}</p>
      )}
      {hint ? <p className="composer-effort-hint">{hint}</p> : null}
      <Popover.Description id={fastDescriptionId} className="composer-fast-description">
        {fastStatus(fast, fastBlocked)}
        {fastHint}
      </Popover.Description>
    </>
  );
}

/** Whose effort a team conversation's panel sets, or why an Orcling lead's cannot change here. */
function TeamLeadNote({ team }: { team: EffortTeam }) {
  return (
    <p className="text-xs text-ink-3 text-center mt-2">
      {team.leadName} · Revision {team.revision}
      <br />
      {team.leadOrcling ? `${team.leadOrcling} leads with its own model and effort. Edit ${team.leadOrcling} to change them.` : "Effort and Fast apply to this task’s lead."}
    </p>
  );
}

export function effortAvailability(model: ModelOption | undefined, selected: boolean, loading: boolean, failed: boolean): string {
  if (model?.unavailable) return model.unavailable;
  if (loading) return "Loading effort options…";
  if (failed) return "Could not load effort options. Try Refresh models.";
  if (!model) return selected ? "Effort options are unavailable for the selected model. Try Refresh models." : "Choose a model to adjust its effort.";
  return model.efforts.length === 1 ? "This connection offers one effort option for this model." : "This connection does not advertise adjustable effort options for this model.";
}

type EffortControlProps = { efforts: string[]; value: number; fast: boolean; onChange: (index: number) => void; disabled?: boolean };

export function EffortControl({ agent, ...props }: EffortControlProps & { agent: AgentKind }) {
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

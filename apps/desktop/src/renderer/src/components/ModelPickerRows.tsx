import type { KeyboardEvent, ReactNode } from "react";
import type { ModelOption, Orcling } from "@openorc/protocol";
import { useRouter } from "../lib/router";
import { Check, Plus } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";

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

/** Orclings a picker offers; choosing one brings its own model, instructions and memory. */
export interface OrclingPickerChoices {
  options: readonly Orcling[];
  selectedId?: string | null;
  onSelect: (orcling: Orcling) => void;
  /** Why none can be chosen here, shown instead of the list. */
  unavailable?: string;
}

export type RowProps = { disabled?: boolean | undefined; closeOnSelect: boolean; close: () => void; moveRowFocus: (event: KeyboardEvent<HTMLButtonElement>) => void };

/** Saved teams of the project, with why any cannot start here. */
export function TeamRows({ teams, disabled, closeOnSelect, close, moveRowFocus }: RowProps & { teams: TeamPickerChoices | undefined }) {
  return (
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
  );
}

/** Orclings the picker offers, each with the model it brings. */
export function OrclingRows({ orclings, models, disabled, closeOnSelect, close, moveRowFocus }: RowProps & { orclings: OrclingPickerChoices | undefined; models: ModelOption[] }) {
  if (orclings?.unavailable) return <p className="model-picker-message">{orclings.unavailable}</p>;
  if (!orclings?.options.length) {
    return (
      <button type="button" className="model-picker-text-action" onClick={() => useRouter.getState().navigate({ view: "orcling" })}>
        <Plus size={14} /> Create an Orcling
      </button>
    );
  }
  return (
    <>
      {orclings.options.map((orcling) => {
        const model = models.find((option) => option.agent === orcling.settings.agent && option.id === orcling.settings.model);
        const selected = orclings.selectedId === orcling.id;
        return (
          <button
            key={orcling.id}
            type="button"
            data-picker-row
            className="model-picker-row model-picker-orcling-row"
            aria-pressed={selected}
            disabled={disabled}
            title={`${orcling.name} · ${model?.label ?? orcling.settings.model}`}
            onClick={() => {
              orclings.onSelect(orcling);
              if (closeOnSelect) close();
            }}
            onKeyDown={moveRowFocus}
          >
            <OrclingAvatar orcling={orcling} size={20} />
            <span className="model-picker-row-name">{orcling.name}</span>
            <span className="model-picker-row-meta">{model?.label ?? orcling.settings.model}</span>
            {selected ? <Check size={15} className="model-picker-check" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </>
  );
}

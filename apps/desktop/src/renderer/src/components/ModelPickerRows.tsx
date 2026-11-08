import type { ModelOption, Orcling } from "@openorc/protocol";
import type { KeyboardEvent } from "react";
import { useRouter } from "../lib/router";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { Check, Plus } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";

/** Orclings a picker offers; choosing one brings its own model, instructions and memory. */
export interface OrclingPickerChoices {
  options: readonly Orcling[];
  selectedId?: string | null;
  onSelect: (orcling: Orcling) => void;
  /** Why none can be chosen here, shown instead of the list. */
  unavailable?: string;
}

export type RowProps = { disabled?: boolean | undefined; closeOnSelect: boolean; close: () => void; moveRowFocus: (event: KeyboardEvent<HTMLButtonElement>) => void };

/** Orclings the picker offers, each with the model it brings. */
export function OrclingRows({ orclings, models, disabled, closeOnSelect, close, moveRowFocus }: RowProps & { orclings: OrclingPickerChoices | undefined; models: ModelOption[] }) {
  const enabled = useEnabledHarnesses();
  const options = orclings?.options.filter((orcling) => enabled.includes(orcling.settings.agent)) ?? [];
  if (orclings?.unavailable) return <p className="model-picker-message">{orclings.unavailable}</p>;
  if (!orclings || !options.length) {
    return (
      <button type="button" className="model-picker-text-action" onClick={() => useRouter.getState().navigate({ view: "orcling" })}>
        <Plus size={14} /> Create an Orcling
      </button>
    );
  }
  return (
    <>
      {options.map((orcling) => {
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

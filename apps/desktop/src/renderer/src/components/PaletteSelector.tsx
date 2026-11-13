import { useId, useState, type CSSProperties } from "react";
import { Check, ChevronDown } from "./icons";
import { TextButton } from "./ui";
import { themePresets, type Mode, type ThemePreset, overridesFor, type CustomColors, resolveAccentColors } from "@openorc/client/theme";
import { toHex } from "../lib/color";
import "./PaletteSelector.css";

export function PaletteSelector({
  preset,
  mode,
  custom,
  onChange,
  compact = false,
}: {
  preset: ThemePreset;
  mode: Mode;
  custom: CustomColors;
  onChange: (preset: ThemePreset) => void;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const choicesId = useId();
  const selected = themePresets.find((theme) => theme.id === preset)!;
  const initialChoices = themePresets.slice(0, 6);
  const collapsedChoices = initialChoices.includes(selected) ? initialChoices : [...initialChoices.slice(0, -1), selected];
  const choices = compact && !expanded ? collapsedChoices : themePresets;
  return (
    <div className="palette-selector">
      <div className="palette-choices" id={choicesId} role="group" aria-label="Color palette">
        {choices.map((theme) => (
          <button className="palette-choice" type="button" key={theme.id} aria-label={`${theme.name} palette`} aria-pressed={preset === theme.id} onClick={() => onChange(theme.id)}>
            <span className="palette-swatches" style={resolveAccentColors(theme.colors[mode], overridesFor(custom, theme.id, mode), toHex) as CSSProperties} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="palette-choice-name">{theme.name}</span>
            <Check className="palette-choice-check" size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
      {compact ? (
        <TextButton className="palette-expand" tone="muted" aria-expanded={expanded} aria-controls={choicesId} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Fewer palettes" : `All ${themePresets.length} palettes`} <ChevronDown size={12} />
        </TextButton>
      ) : (
        <p className="palette-description">{selected.description}</p>
      )}
    </div>
  );
}

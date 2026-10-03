import type { CSSProperties } from "react";
import { Check } from "./icons";
import { themePresets, type Mode, type ThemePreset } from "../lib/theme-palettes";
import { overridesFor, type CustomColors } from "../lib/theme-custom";
import { resolveAccentColors } from "../lib/theme-accents";
import "./PaletteSelector.css";

export function PaletteSelector({ preset, mode, custom, onChange }: { preset: ThemePreset; mode: Mode; custom: CustomColors; onChange: (preset: ThemePreset) => void }) {
  const selected = themePresets.find((theme) => theme.id === preset)!;
  return (
    <div className="palette-selector">
      <div className="palette-choices" role="group" aria-label="Color palette">
        {themePresets.map((theme) => (
          <button className="palette-choice" type="button" key={theme.id} aria-label={`${theme.name} palette`} aria-pressed={preset === theme.id} onClick={() => onChange(theme.id)}>
            <span className="palette-swatches" style={resolveAccentColors(theme.colors[mode], overridesFor(custom, theme.id, mode)) as CSSProperties} aria-hidden="true">
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
      <p className="palette-description">{selected.description}</p>
    </div>
  );
}

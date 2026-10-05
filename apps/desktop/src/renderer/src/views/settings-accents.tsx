import { type CSSProperties } from "react";
import { Check, ChevronRight } from "../components/icons";
import { ColorRow } from "../components/ColorRow";
import { themePresets, useTheme } from "../lib/theme";
import { accentCombinations, accentRoles, accentTokens, combinationColors, resolveAccentColors } from "../lib/theme-accents";
import { accentHex } from "../lib/accent-colors";
import { overridesFor } from "../lib/theme-custom";
import { Section } from "./settings-shared";

export function AccentSettings({ report }: { report: (saved: boolean) => void }) {
  const { preset, resolved, custom, setAccent, setAccentCombination, resetAccents } = useTheme();
  const overrides = overridesFor(custom, preset, resolved);
  const base = themePresets.find((theme) => theme.id === preset)!.colors[resolved];
  const colors = resolveAccentColors(base, overrides);
  const changed = accentTokens.some((token) => token in overrides);
  return (
    <Section flush title="Accent colors" description="Start with your theme's accents, or customize actions, navigation, and content. Light and dark keep separate choices.">
      <div className="accent-combinations" role="group" aria-label="Accent combinations">
        <button type="button" aria-pressed={!changed} onClick={() => report(resetAccents())}>
          <AccentSwatches colors={accentRoles.map(({ token }) => accentHex(base[token]))} />
          Palette default
        </button>
        {accentCombinations.map((combination) => {
          const selected = Object.entries(combinationColors(combination.id, resolved)).every(([token, value]) => overrides[token] === value);
          return (
            <button key={combination.id} type="button" aria-pressed={selected} onClick={() => report(setAccentCombination(combination.id))}>
              <AccentSwatches colors={combination[resolved]} />
              {combination.name}
            </button>
          );
        })}
      </div>
      <div className="accent-editor">
        <div className="accent-role-controls">
          {accentRoles.map(({ token, label, description }) => (
            <div key={token} className="accent-role">
              <ColorRow label={label} value={accentHex(colors[token])} changed={token in overrides} onChange={(value) => report(setAccent(token, value))} onReset={() => report(resetAccents(token))} />
              <p>{description}</p>
            </div>
          ))}
        </div>
        <div className="accent-example" style={colors as CSSProperties} aria-label="Accent color preview">
          <div className="accent-example-navigation">
            <Check size={13} /> Current thread <ChevronRight size={13} />
          </div>
          <p>
            A focused place for your next idea. <span className="accent-example-link">View changes</span>
          </p>
          <span className="accent-example-action">New thread</span>
        </div>
      </div>
      <p className="accent-note">Text and tints adapt for readability. Status colors keep their meaning.</p>
    </Section>
  );
}

function AccentSwatches({ colors }: { colors: readonly string[] }) {
  return (
    <span className="accent-swatches" aria-hidden="true">
      {colors.map((color, index) => (
        <i key={index} style={{ background: color }} />
      ))}
    </span>
  );
}

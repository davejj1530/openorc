import { useMemo, useState } from "react";
import { Monitor, Moon, Sun } from "../components/icons";
import { Button } from "../components/ui";
import { cn } from "../lib/cn";
import { toHex } from "../lib/color";
import { themePresets, useTheme, type ThemeChoice } from "../lib/theme";
import { colorGroups, editableTokens, overridesFor } from "../lib/theme-custom";
import { Field, Section, Toggle } from "./settings-shared";
import { useWindowAppearance } from "../lib/window-appearance";
import { PaletteSelector } from "../components/PaletteSelector";
import { MascotStill } from "../components/MascotStill";
import { ColorRow } from "../components/ColorRow";
import { AccentSettings } from "./settings-accents";
import { resolveAccentColors } from "../lib/theme-accents";

const modes = [
  { id: "system", name: "System", icon: Monitor },
  { id: "light", name: "Light", icon: Sun },
  { id: "dark", name: "Dark", icon: Moon },
] satisfies { id: ThemeChoice; name: string; icon: typeof Sun }[];

type Report = (saved: boolean) => void;

export function AppearanceSettings() {
  const { choice, preset, resolved, custom, set, setPreset } = useTheme();
  const [status, setStatus] = useState("");
  const report: Report = (saved) => setStatus(saved ? "Appearance saved" : "Applied for this session. Storage is unavailable; select again to retry saving.");
  return (
    <>
      <Section title="Color appearance" description="Use a light or dark workspace, or follow your device.">
        <div className="appearance-modes" role="group" aria-label="Color appearance">
          {modes.map(({ id, name, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={choice === id} onClick={() => report(set(id))}>
              <Icon size={16} />
              {name}
            </button>
          ))}
        </div>
      </Section>
      <AccentSettings report={report} />
      <Section flush title="Palette" description="Product palettes for your workspace. Every palette works in light and dark.">
        <PaletteSelector preset={preset} mode={resolved} custom={custom} onChange={(next) => report(setPreset(next))} />
      </Section>
      <WindowAppearanceSettings report={report} />
      <details className="appearance-advanced">
        <summary>Fine-tune individual colors</summary>
        <ColorEditor report={report} />
      </details>
      <p className="appearance-status" role="status">
        {status}
      </p>
    </>
  );
}

function WindowAppearanceSettings({ report }: { report: Report }) {
  const { transparent, transparency, supported, reducedTransparency, failed, setTransparent, setTransparency } = useWindowAppearance();
  let note = "";
  if (failed) note = "Could not update the window. Restart OpenOrc to apply your appearance.";
  else if (!supported) note = "Available on macOS and Windows 11 22H2 or later.";
  else if (reducedTransparency) note = "Your system’s Reduce Transparency setting keeps the surroundings solid.";
  return (
    <Section title="Window">
      <Toggle
        label="Transparent surroundings"
        hint="Let the desktop show through the sidebar and outer rails with a soft blur. Main content stays solid."
        checked={transparent}
        disabled={!supported}
        onChange={(value) => report(setTransparent(value))}
      />
      <Field label="Transparency" hint="Higher values reveal more of the desktop. The background stays blurred.">
        <span className="transparency-control">
          <input
            type="range"
            aria-label="Transparency"
            aria-valuetext={`${transparency}% transparency`}
            min={0}
            max={100}
            step={1}
            value={transparency}
            disabled={!transparent || !supported || reducedTransparency || failed}
            onChange={(event) => report(setTransparency(event.target.valueAsNumber))}
          />
          <span className="tabular text-ink-2" aria-hidden="true">
            {transparency}%
          </span>
        </span>
      </Field>
      {note && (
        <p role={failed ? "alert" : undefined} className={cn("text-sm mt-2", failed ? "text-bad" : "text-ink-2")}>
          {note}
        </p>
      )}
    </Section>
  );
}

function ColorEditor({ report }: { report: Report }) {
  const { preset, resolved, custom, setColor, resetColor, resetColors } = useTheme();
  const theme = themePresets.find((entry) => entry.id === preset)!;
  const overrides = overridesFor(custom, preset, resolved);
  const colors = resolveAccentColors(theme.colors[resolved], overrides);
  const changed = Object.keys(overrides).length;
  // The palette authors colors in syntaxes the picker cannot read, so resolve
  // each one to hex once per palette and appearance mode.
  const groups = useMemo(
    () =>
      colorGroups.map((group) => ({
        name: group.name,
        tokens: group.tokens.map(({ token, label }) => ({ token, label, base: toHex(theme.colors[resolved][token]) ?? "#000000" })),
      })),
    [theme, resolved],
  );
  return (
    <Section title="Colors" description="Change any color in the palette you picked. Light and dark keep their own values.">
      <div className="color-editor-head">
        <p>{changed === 0 ? `Showing the ${resolved} colors of ${theme.name}.` : `${changed} of ${editableTokens.length} ${resolved} colors changed from ${theme.name}.`}</p>
        <Button size="sm" disabled={changed === 0} onClick={() => report(resetColors())}>
          Reset all
        </Button>
      </div>
      {groups.map((group) => (
        <div key={group.name} className="color-group">
          <h3>{group.name}</h3>
          {group.name === "Mascot" && <MascotStill className="block w-20 h-20" />}
          <div className="color-rows">
            {group.tokens.map(({ token, label, base }) => (
              <ColorRow
                key={token}
                label={label}
                value={toHex(colors[token]) ?? base}
                changed={token in overrides}
                onChange={(hex) => report(setColor(token, hex))}
                onReset={() => report(resetColor(token))}
              />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

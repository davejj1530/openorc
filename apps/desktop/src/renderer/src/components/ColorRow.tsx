import { useState, type CSSProperties } from "react";
import { RotateCcw } from "./icons";
import { cn } from "../lib/cn";
import { normalizeHex } from "../lib/theme-custom";

/** One editable color. With `alpha`, `value` may be `#rrggbbaa`: the swatch shows it over the window
 * ground and edits the color while keeping the alpha; the hex field edits both. */
export function ColorRow({
  label,
  value,
  alpha = false,
  changed,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  alpha?: boolean;
  changed: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  const valid = normalizeHex(text, alpha) !== null;
  const opacity = value.slice(7);
  const commit = () => {
    const hex = normalizeHex(text, alpha);
    setDraft(null);
    if (hex !== null && hex !== value) onChange(hex);
  };
  return (
    <div className="color-row">
      <input
        className="color-swatch"
        type="color"
        value={value.slice(0, 7)}
        style={{ "--swatch-color": value } as CSSProperties}
        aria-label={label}
        onChange={(event) => onChange(event.target.value + opacity)}
      />
      <span className={cn("color-row-label", changed ? "text-ink" : "text-ink-2")}>{label}</span>
      <input
        className={cn("color-row-hex native-field", !valid && "color-row-hex-invalid")}
        value={text}
        spellCheck={false}
        aria-label={`${label} hex value`}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(null);
        }}
      />
      {changed && (
        <button type="button" className="color-row-reset" title={`Reset ${label} to the palette`} aria-label={`Reset ${label} to the palette`} onClick={onReset}>
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

import { useState } from "react";
import { RotateCcw } from "./icons";
import { cn } from "../lib/cn";
import { normalizeHex } from "../lib/theme-custom";

export function ColorRow({ label, value, changed, onChange, onReset }: { label: string; value: string; changed: boolean; onChange: (hex: string) => void; onReset: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  const valid = normalizeHex(text) !== null;
  const commit = () => {
    const hex = normalizeHex(text);
    setDraft(null);
    if (hex !== null && hex !== value) onChange(hex);
  };
  return (
    <div className="color-row">
      <input className="color-swatch" type="color" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
      <span className={cn("color-row-label", changed && "font-medium")}>{label}</span>
      <input
        className={cn("color-row-hex", !valid && "color-row-hex-invalid")}
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

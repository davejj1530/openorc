import { useRef, useState, type ChangeEvent } from "react";
import { DitherBackdrop } from "../components/DitherBackdrop";
import { Button } from "../components/ui";
import { backdropGrids, backdropImage, backdropLimits, backdropPatterns, useBackdrop, type BackdropStyle } from "../lib/backdrop";
import { Field, Section, SettingRow, Toggle } from "./settings-shared";

type Report = (saved: boolean) => void;

/** One slider row: its value shown beside it, read out in the unit that matters. */
function Range({ label, value, min, max, unit, disabled, onChange }: { label: string; value: number; min: number; max: number; unit: string; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <span className="range-control">
        <input
          type="range"
          aria-label={label}
          aria-valuetext={`${value}${unit}`}
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
        <span className="tabular text-ink-2" aria-hidden="true">
          {value}
          {unit}
        </span>
      </span>
    </Field>
  );
}

/**
 * The new thread screen's backdrop: its style (off, one of the dither's patterns, or the user's own image dithered
 * alike), a live preview while one shows, then the grid, the dots' size and how fast a pattern moves.
 */
export function BackdropSettings({ report }: { report: Report }) {
  const backdrop = useBackdrop();
  const { change, chooseImage, removeImage } = useBackdrop.getState();
  const file = useRef<HTMLInputElement>(null);
  const [imageHint, setImageHint] = useState<string>();
  const styles: { id: BackdropStyle; name: string }[] = [{ id: "off", name: "Off" }, ...backdropPatterns, ...(backdrop.image ? [{ id: "image" as const, name: "Image" }] : [])];
  const shown = backdrop.style !== "off";
  const take = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    const image = await backdropImage(chosen);
    if (!image) {
      setImageHint("That file isn’t an image OpenOrc can read.");
      return;
    }
    const saved = chooseImage(image);
    // Full storage needs a smaller image, not the retry the shared save message suggests.
    setImageHint(saved === "full" ? "Applied for this session. This image is too large to save; try a smaller one." : undefined);
    if (saved !== "full") report(saved === "saved");
  };
  const pick = (style: BackdropStyle) => {
    setImageHint(undefined);
    report(change({ style }));
  };
  const remove = () => {
    setImageHint(undefined);
    report(removeImage());
  };
  return (
    <Section flush title="New thread backdrop" description="The dithered pattern behind a new thread.">
      <div className="appearance-modes" role="group" aria-label="Backdrop style">
        {styles.map(({ id, name }) => (
          <button key={id} type="button" aria-pressed={backdrop.style === id} onClick={() => pick(id)}>
            {name}
          </button>
        ))}
      </div>
      {shown ? (
        <div className="backdrop-preview">
          <DitherBackdrop />
        </div>
      ) : null}
      <div className="settings-group backdrop-controls">
        <SettingRow label="Image" hint={imageHint}>
          {backdrop.image ? <img className="backdrop-thumb" src={backdrop.image} alt="" /> : null}
          <input ref={file} type="file" accept="image/*" hidden onChange={(event) => void take(event)} />
          <Button size="sm" onClick={() => file.current?.click()}>
            {backdrop.image ? "Replace…" : "Choose image…"}
          </Button>
          {backdrop.image ? (
            <Button size="sm" onClick={remove}>
              Remove
            </Button>
          ) : null}
        </SettingRow>
        {backdrop.style === "image" ? <Toggle label="Keep the image’s colors" checked={backdrop.imageColors} disabled={false} onChange={(value) => report(change({ imageColors: value }))} /> : null}
        <SettingRow label="Grid">
          <span className="appearance-modes" role="group" aria-label="Grid">
            {backdropGrids.map(({ id, name }) => (
              <button key={id} type="button" aria-pressed={backdrop.grid === id} disabled={!shown} onClick={() => report(change({ grid: id }))}>
                {name}
              </button>
            ))}
          </span>
        </SettingRow>
        <Range label="Dot size" value={backdrop.size} {...backdropLimits.size} unit=" px" disabled={!shown} onChange={(size) => report(change({ size }))} />
        <Range label="Motion" value={backdrop.motion} {...backdropLimits.motion} unit="%" disabled={!shown || backdrop.style === "image"} onChange={(motion) => report(change({ motion }))} />
      </div>
    </Section>
  );
}

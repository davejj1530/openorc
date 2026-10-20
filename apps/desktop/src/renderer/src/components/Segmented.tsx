import { useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useSlidingKnob } from "../lib/use-sliding-knob";

type SegmentedSize = "sm" | "md" | "lg";

const segmentSizes: Record<SegmentedSize, string> = {
  sm: "h-6.5 px-3.5 text-sm",
  md: "h-7 px-4 text-sm",
  lg: "h-8 px-5 text-base",
};

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean; reason?: string };

/**
 * One choice from a short set: a fill track at its natural width, with a surface knob that
 * slides under the chosen label. The track scrolls sideways when the row runs out of room,
 * and the knob scrolls with it.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
  className,
}: {
  value: T;
  /** A disabled option can say why on hover. */
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  size?: SegmentedSize;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const knob = useSlidingKnob(track, '[aria-checked="true"]', value);
  return (
    <div ref={track} role="radiogroup" aria-label={label} className={cn("segmented", className)}>
      <span aria-hidden="true" className="segmented-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          title={option.disabled ? option.reason : undefined}
          onClick={() => onChange(option.value)}
          className={cn("segmented-option", segmentSizes[size])}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

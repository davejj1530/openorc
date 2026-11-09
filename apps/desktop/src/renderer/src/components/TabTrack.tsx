import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useSlidingKnob } from "../lib/use-sliding-knob";

export type TabTrackItem<T extends string> = { id: T; label: ReactNode };

/**
 * Tabs drawn as the segmented track: a fill track at its natural width with a surface knob
 * sliding under the open tab. Unlike Segmented these are tabs (role tab), so a screen's
 * sections keep their tab semantics.
 */
export function TabTrack<T extends string>({
  label,
  items,
  value,
  onSelect,
  panelId,
  className,
}: {
  label: string;
  items: readonly TabTrackItem<T>[];
  value: T;
  onSelect: (id: T) => void;
  panelId?: string;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const knob = useSlidingKnob(track, '[aria-selected="true"]', value);
  useEffect(() => {
    track.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <div ref={track} role="tablist" aria-label={label} className={cn("segmented tab-track", className)}>
      <span aria-hidden="true" className="segmented-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          aria-controls={panelId}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === "ArrowRight") next = (index + 1) % items.length;
            else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else return;
            event.preventDefault();
            const target = items[next];
            if (!target) return;
            track.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            onSelect(target.id);
          }}
          className="segmented-option h-7 px-4 text-sm"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

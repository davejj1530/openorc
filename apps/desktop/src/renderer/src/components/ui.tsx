import { createContext, forwardRef, useContext, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "./icons";
import selectChevron from "./icons-select.svg?url";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

export { Segmented, type SegmentedOption } from "./Segmented";

/* Small, boring primitives. The design lives in the tokens, not here. */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "xl" | "hero";
type IconSize = "xs" | "sm" | "md" | "lg";

/**
 * Trailing metadata in a list row: a fixed slot that never wraps and whose
 * numerals align down the column. Callers add the width that fits their data.
 */
export const metaSlot = "shrink-0 text-right text-ink-4 tabular whitespace-nowrap";

/*
 * Pills without borders. Primary is the one ink pill on a screen; secondary sits on
 * --control-fill, which is the right step for the ground it lands on; ghost is bare.
 * hover-step layers the fill step over a control's own fill (styles/controls.css), so a
 * hover reads on the tile and on a plane alike.
 *
 * Each variant states its own disabled colors. Opacity would composite the label
 * and the fill toward whatever sits behind them, which is how the send button
 * reached 2.3:1. A variant that carries a fill at rest keeps one when disabled;
 * ghost is transparent at rest, so it only drops its ink.
 */
const disabledFill = "disabled:bg-surface-3 disabled:text-ink-3";
const variants: Record<Variant, string> = {
  primary: `ink-pill hover-step focus-ring bg-accent text-accent-fg ${disabledFill}`,
  secondary: `hover-step bg-control-fill text-ink ${disabledFill}`,
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink active:bg-surface-3 disabled:text-ink-4",
  danger: `hover-step bg-control-fill text-bad ${disabledFill}`,
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-3 text-sm gap-1",
  md: "h-7.5 px-3.5 text-base gap-1.5",
  lg: "h-8 px-3.5 text-base gap-1.5",
  xl: "h-9 px-4 text-base gap-1.5",
  hero: "h-10 px-5 text-md gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("inline-flex items-center justify-center rounded-full whitespace-nowrap select-none disabled:pointer-events-none", variants[variant], sizes[size], className)}
      {...props}
    />
  );
});

const iconSizes: Record<IconSize, string> = { xs: "size-6", sm: "size-7", md: "size-7.5", lg: "size-8" };

/**
 * A round control carrying one glyph: toolbar toggles, header controls, row
 * affordances. Quiet at rest, the fill step on hover and keyboard focus, never
 * an outline. While its menu is open or it is pressed it keeps the fill and full
 * ink. The accessible name is required because the glyph is not a label.
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { size?: IconSize; "aria-label": string }>(function IconButton(
  { className, size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "grid place-items-center shrink-0 rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink active:bg-surface-3 aria-expanded:bg-surface-2 aria-expanded:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink disabled:bg-transparent disabled:text-ink-4 disabled:pointer-events-none",
        iconSizes[size],
        className,
      )}
      {...props}
    />
  );
});

type TextTone = "inherit" | "faint" | "muted" | "strong" | "danger";
const textTones: Record<TextTone, string> = {
  inherit: "",
  faint: "text-ink-4 hover:text-ink",
  muted: "text-ink-3 hover:text-ink",
  strong: "text-ink hover:text-ink-2",
  danger: "text-ink-4 hover:text-bad",
};

/**
 * An inline control that lives inside a sentence or a row. It inherits the type
 * size around it and owns only ink, underline and hover, so it never breaks a
 * line of prose the way Button's border, fill and fixed height would. `inherit`
 * is the default because these often sit inside an already-coloured paragraph.
 */
export const TextButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: TextTone; underline?: boolean }>(function TextButton(
  { className, tone = "inherit", underline = false, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("text-left transition-colors disabled:text-ink-4 disabled:pointer-events-none", textTones[tone], underline && "underline underline-offset-2", className)}
      {...props}
    />
  );
});

/*
 * Fields are a fill with no border: 32px with a 10px corner inline, 40px with a 12px corner in
 * sheets. Focus deepens the fill and shows the caret; there is no ring. On the deeper fill the
 * placeholder steps up from faint to muted, since nothing faint sits on --surface-3.
 */
type FieldVariant = "inline" | "sheet";
const fieldBase = "native-field min-w-0 border-0 bg-surface-2 text-base text-ink placeholder:text-ink-4 focus:bg-surface-3 focus:placeholder:text-ink-3";
const fieldShapes: Record<FieldVariant, string> = { inline: "rounded-md", sheet: "rounded-lg" };
const lineFieldSizes: Record<FieldVariant, string> = { inline: "h-8 px-3", sheet: "h-10 px-3" };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { variant?: FieldVariant }>(function Input({ className, variant = "inline", ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, "w-full", fieldShapes[variant], lineFieldSizes[variant], className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { variant?: FieldVariant }>(function Textarea({ className, variant = "inline", ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, "block w-full px-3 py-2 resize-none", fieldShapes[variant], variant === "sheet" && "py-2.5", className)} {...props} />;
});

export function Select({ className, children, variant = "inline", ...props }: SelectHTMLAttributes<HTMLSelectElement> & { variant?: FieldVariant }) {
  return (
    <select
      className={cn(fieldBase, "max-w-full pl-3 pr-7 appearance-none bg-no-repeat", fieldShapes[variant], variant === "sheet" ? "h-10" : "h-8", className)}
      style={{
        backgroundImage: `url("${selectChevron}")`,
        backgroundPosition: "right 10px center",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

type BadgeTone = "muted" | "accent" | "ok" | "warn" | "bad";
const badgeTones: Record<BadgeTone, string> = {
  muted: "text-ink-2",
  accent: "text-accent-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

/**
 * A short label on a neutral fill pill. Data shows as marks, so the tone only colors the
 * words; there is no tinted ground. Prefer StatusDot for state and CountBadge for numbers.
 */
export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return <span className={cn("inline-flex items-center h-5.5 px-2 rounded-full bg-surface-2 text-xs whitespace-nowrap tabular", badgeTones[tone], className)}>{children}</span>;
}

type DotTone = "attention" | "ok" | "bad" | "live" | "muted";
const dotTones: Record<DotTone, string> = {
  attention: "bg-attention",
  ok: "bg-ok",
  bad: "bg-bad",
  live: "bg-ink",
  muted: "bg-ink-4",
};

/**
 * A 7px state mark beside a row's label. Decorative unless it carries a `label`, which it
 * should whenever nothing else on the row says the same thing.
 */
export function StatusDot({ tone, label, className }: { tone: DotTone; label?: string; className?: string }) {
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("inline-block size-1.75 shrink-0 rounded-full", dotTones[tone], className)} />;
}

type CountSize = "sm" | "md";
const countSizes: Record<CountSize, string> = { sm: "h-4 min-w-4 px-1", md: "h-5 min-w-5 px-1.5" };
const countTones = { ink: "bg-accent text-accent-fg", quiet: "bg-surface-2 text-ink-3" } as const;

/**
 * A count on a round pill. When the number changes the digits roll, up for more and down for
 * fewer, with one overshoot; the first render never animates. Past `max` it reads "99+".
 */
export function CountBadge({ count, max = 99, size = "md", tone = "ink", className }: { count: number; max?: number; size?: CountSize; tone?: keyof typeof countTones; className?: string }) {
  const text = count > max ? `${max}+` : String(count);
  const [roll, setRoll] = useState<{ count: number; text: string; previous: string | null; direction: "up" | "down" }>({ count, text, previous: null, direction: "up" });
  if (roll.text !== text) setRoll({ count, text, previous: roll.text, direction: count >= roll.count ? "up" : "down" });
  return (
    <span className={cn("count-badge text-xs tabular", countSizes[size], countTones[tone], className)} data-roll={roll.direction}>
      {roll.previous !== null ? (
        <span key={`out-${roll.previous}-${roll.text}`} className="count-badge-out" aria-hidden="true">
          {roll.previous}
        </span>
      ) : null}
      <span key={roll.text} className={cn(roll.previous !== null && "count-badge-in")}>
        {roll.text}
      </span>
    </span>
  );
}

/**
 * A filter pill that toggles (aria-pressed). Pressed it is the ink pill, with its count at
 * 60% of the label; otherwise it sits on --control-fill with a faint count.
 */
export const Chip = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & { pressed: boolean; count?: ReactNode }>(function Chip(
  { className, pressed, count, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={cn(
        "chip inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-base whitespace-nowrap disabled:pointer-events-none disabled:text-ink-3",
        pressed ? "ink-pill hover-step focus-ring bg-accent text-accent-fg" : "hover-step bg-control-fill text-ink",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? <span className="chip-count text-sm tabular">{count}</span> : null}
    </button>
  );
});

/**
 * A capsule-and-knob switch: a fill track holding a surface knob that springs across with one
 * overshoot. On, the track fills with --ink rather than --accent, so a view keeps one hot
 * element. md is 38x22, sm 30x18. It stays a native checkbox with role="switch".
 */
export const Switch = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & { "aria-label"?: string; size?: "sm" | "md" }>(function Switch(
  { className, size = "md", ...props },
  ref,
) {
  return (
    <span className={cn("settings-switch", className)} data-size={size}>
      <input ref={ref} type="checkbox" role="switch" {...props} />
      <span className="settings-switch-knob" aria-hidden="true" />
    </span>
  );
});

const TooltipGroup = createContext(false);

/**
 * One tooltip group for the window: after one tooltip opens, its neighbours open without a second
 * delay. Mounted once in App.tsx.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={400}>
      <TooltipGroup.Provider value={true}>{children}</TooltipGroup.Provider>
    </BaseTooltip.Provider>
  );
}

/** Names a control on hover. Outside a TooltipProvider it keeps its own 400ms delay. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const grouped = useContext(TooltipGroup);
  const tooltip = (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<span className="inline-flex" />}>{children}</BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup ref={floatingGround} className="tooltip-popup">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
  return grouped ? tooltip : <BaseTooltip.Provider delay={400}>{tooltip}</BaseTooltip.Provider>;
}

/**
 * A modal sheet: r20 over a dimmed backdrop, a 14px title with no divider and a round close. Base
 * UI returns focus to the control that opened it.
 */
export function Dialog({ open, onOpenChange, title, children, width = 480 }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; width?: number }) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <CoversPreview />
        <BaseDialog.Backdrop className="dialog-backdrop fixed inset-0" />
        <BaseDialog.Popup className="dialog-sheet fixed inset-x-0 top-1/5 mx-auto" style={{ width }}>
          <div className="dialog-sheet-head">
            <BaseDialog.Title className="dialog-sheet-title">{title}</BaseDialog.Title>
            <BaseDialog.Close render={<IconButton aria-label="Close" size="sm" />}>
              <X size={15} />
            </BaseDialog.Close>
          </div>
          <div className="dialog-sheet-body">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid min-w-0 gap-1 mb-3">
      <span className="text-sm text-ink-3">{label}</span>
      {children}
      {hint ? <span className="text-xs text-ink-4">{hint}</span> : null}
    </label>
  );
}

/**
 * Nothing here yet, said in a way that teaches what goes here. `icon` sets the
 * subject, `children` says what fills this surface, and `action` offers the
 * first step rather than leaving the reader to find it.
 */
export function Empty({ title, children, icon, action }: { title: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="h-full grid place-items-center text-center px-6 py-12">
      <div className="max-w-sm grid justify-items-center">
        {icon ? <span className="mb-3 text-ink-4">{icon}</span> : null}
        <div className="text-md text-ink">{title}</div>
        {children ? <div className="mt-1 text-base text-ink-3">{children}</div> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

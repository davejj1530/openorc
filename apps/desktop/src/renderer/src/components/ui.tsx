import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "./icons";
import selectChevron from "./icons-select.svg?url";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";

/* Small, boring primitives. The design lives in the tokens, not here. */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/**
 * Trailing metadata in a list row: a fixed slot that never wraps and whose
 * numerals align down the column. Callers add the width that fits their data.
 */
export const metaSlot = "shrink-0 text-right text-ink-4 tabular whitespace-nowrap";

/*
 * Each variant states its own disabled colors. Opacity would composite the label
 * and the fill toward whatever sits behind them, which is how the send button
 * reached 2.3:1. A variant that carries a fill at rest keeps one when disabled;
 * ghost is transparent at rest, so it only drops its ink.
 */
const disabledFill = "disabled:bg-surface-3 disabled:text-ink-3 disabled:border-transparent";
const variants: Record<Variant, string> = {
  primary: `bg-accent text-accent-fg hover:brightness-110 border-transparent ${disabledFill}`,
  secondary: `bg-surface-2 text-ink border-transparent hover:bg-surface-3 ${disabledFill}`,
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-surface-2 hover:text-ink disabled:text-ink-4",
  danger: `bg-surface text-bad border-line hover:bg-bad-soft ${disabledFill}`,
};
const sizes: Record<Size, string> = {
  sm: "h-6 px-2 text-sm gap-1",
  md: "h-7 px-2.5 text-base gap-1.5",
  lg: "h-8 px-3 text-base gap-1.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none transition-colors active:brightness-95 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});

const iconSizes: Record<Size, string> = { sm: "w-6 h-6", md: "w-7 h-7", lg: "w-8 h-8" };

/**
 * A square control carrying one glyph: toolbar toggles, header controls, row
 * affordances. Quiet at rest, neutral fill on hover and keyboard focus, never
 * an outline. The accessible name is required because the glyph is not a label.
 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { size?: Size; "aria-label": string }>(function IconButton(
  { className, size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "grid place-items-center shrink-0 rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:text-ink-4 disabled:pointer-events-none",
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

const segmentSizes: Record<"sm" | "md", string> = { sm: "h-6 px-2 text-sm", md: "h-7 px-2.5 text-base" };

/**
 * One choice from a short set, in a header strip. Selection is carried by ink
 * and weight on a transparent ground, the same quiet pattern the composer's
 * Plan/Act control uses. A filled tile would overstate a filter.
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
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-1 min-w-0", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn("rounded-md whitespace-nowrap transition-colors text-ink-3 hover:bg-surface-2 hover:text-ink", segmentSizes[size], value === option.value && "text-ink font-medium")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("native-field h-8 min-w-0 w-full rounded-md border border-line bg-surface px-2.5 text-base placeholder:text-ink-4", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={cn("native-field block min-w-0 w-full rounded-md border border-line bg-surface px-2.5 py-2 text-base placeholder:text-ink-4 resize-none", className)} {...props} />
  );
});

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("native-field h-7 min-w-0 max-w-full rounded-md border border-line bg-surface pl-2 pr-6 text-base appearance-none bg-no-repeat", className)}
      style={{
        backgroundImage: `url("${selectChevron}")`,
        backgroundPosition: "right 6px center",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "accent" | "ok" | "warn" | "bad"; className?: string }) {
  const tones = {
    muted: "bg-surface-2 text-ink-2",
    accent: "bg-accent-soft text-accent-ink",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
  };
  return <span className={cn("inline-flex items-center h-5 px-1.5 rounded-sm text-xs font-medium whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-5 px-1 rounded-sm border border-line bg-surface-2 text-xs text-ink-3">{children}</kbd>;
}

/**
 * A capsule-and-knob switch: a recessed track holding a raised knob, which is the same
 * track-plus-thumb construction the app already uses for the appearance modes and the task
 * destination. It replaces a 13px native checkbox wearing role="switch", whose accent-color
 * painted a saturated square in every settings row and beside every team member. The knob
 * fills with --ink, not --accent, so a view is back to one hot element.
 */
export const Switch = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { "aria-label"?: string }>(function Switch({ className, ...props }, ref) {
  return (
    <span className={cn("settings-switch", className)}>
      <input ref={ref} type="checkbox" role="switch" {...props} />
      <span className="settings-switch-knob" aria-hidden="true" />
    </span>
  );
});

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={400}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={<span className="inline-flex" />}>{children}</BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner sideOffset={6}>
            <BaseTooltip.Popup className="tooltip-popup rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink">{label}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

export function Dialog({ open, onOpenChange, title, children, width = 480 }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; width?: number }) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <CoversPreview />
        <BaseDialog.Backdrop className="fixed inset-0 bg-black/30" />
        <BaseDialog.Popup
          className="fixed left-1/2 top-1/5 -translate-x-1/2 rounded-lg border border-line bg-surface shadow-modal outline-none"
          style={{ width, maxWidth: "calc(100vw - 48px)", maxHeight: "75vh", overflowY: "auto" }}
        >
          <div className="flex items-center justify-between gap-3 px-4 h-10 border-b border-line">
            <BaseDialog.Title className="text-base font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close render={<IconButton aria-label="Close" size="sm" className="-mr-1" />}>
              <X size={14} />
            </BaseDialog.Close>
          </div>
          <div className="p-4">{children}</div>
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
        <div className="text-md font-medium text-ink">{title}</div>
        {children ? <div className="mt-1 text-base text-ink-3">{children}</div> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

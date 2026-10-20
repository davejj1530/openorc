import type { ComponentType, ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "./icons";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { menuItemDetail, menuPopup } from "./menu";

export interface ComposerChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: ComponentType<{ size?: number }>;
  /** A hidden option can still be the current value; the menu just doesn't offer it. */
  hidden?: boolean;
}

/**
 * One choice control for the composer. A chip shows the current value on the control fill; a
 * text trigger reads as part of a sentence. Both open their menu from the control itself, with the
 * same motion as the model picker. Mode, project and destination use it.
 */
export function ComposerChoice<T extends string>({
  value,
  options,
  onChange,
  disabled,
  disabledReason,
  describedBy,
  ariaLabel,
  className,
  look = "chip",
  chevron = false,
  trigger: display,
  side = "top",
  align = "start",
}: {
  value: T;
  options: readonly ComposerChoiceOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  disabledReason?: string;
  describedBy?: string;
  ariaLabel: string;
  className?: string;
  look?: "chip" | "text";
  chevron?: boolean;
  /** Visible trigger content in place of the current label; the accessible name still states the value. */
  trigger?: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  const Icon = current?.icon;
  const chip = look === "chip";
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        aria-describedby={describedBy}
        title={disabled ? disabledReason : current?.hint}
        className={cn(chip ? "composer-chip" : "composer-text-choice", className)}
      >
        {display ?? (
          <>
            {Icon ? <Icon size={14} /> : null}
            <span className="composer-chip-label">{current?.label ?? value}</span>
          </>
        )}
        {chevron || !chip ? <ChevronDown size={12} className="composer-chip-chevron" /> : null}
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side={side} align={align} sideOffset={6} collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "w-64")}>
            {options
              .filter((o) => !o.hidden)
              .map((o) => (
                <Menu.Item key={o.value} className={cn(menuItemDetail, "composer-choice-item")} data-current={value === o.value || undefined} onClick={() => onChange(o.value)}>
                  <span className={cn(value === o.value ? "text-ink" : "text-ink-2")}>{o.label}</span>
                  {o.hint ? <span className="text-sm text-ink-4">{o.hint}</span> : null}
                </Menu.Item>
              ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

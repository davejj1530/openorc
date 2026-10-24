import { Children, createElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";

/*
 * Expo UI's SwiftUI views in tests, as DOM elements that act as the views do: a menu is a button that opens its items,
 * a picker inside it is a set of radio items checked on its selection, and a close button is a button named Close.
 * Modifiers are plain records a stand-in reads.
 */

export type Modifier = { name: string; value: unknown };
type Modified = { modifiers?: Modifier[]; children?: ReactNode };

const modifier =
  (name: string) =>
  (value?: unknown): Modifier => ({ name, value });
const read = (modifiers: Modifier[] | undefined, name: string) => modifiers?.find((item) => item.name === name)?.value;

export const Host = ({ children }: { children: ReactNode }) => createElement("div", null, children);
export const RNHostView = ({ children }: { children: ReactNode }) => createElement("div", null, children);
export const Text = ({ children }: Modified) => createElement("span", null, children);

/** What VoiceOver hears for a view: its label, then its value. */
function spoken(modifiers: Modifier[] | undefined): string | undefined {
  const label = read(modifiers, "accessibilityLabel");
  const value = read(modifiers, "accessibilityValue");
  return label === undefined ? undefined : [label, value].filter(Boolean).join(", ");
}

export function Menu({ label, modifiers, children }: Modified & { label: ReactNode }) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { "aria-label": spoken(modifiers), "aria-expanded": open, onClick: () => setOpen(!open) }, label),
    open ? createElement("div", { role: "menu" }, children) : null,
  );
}

export function Picker<T>({ selection, onSelectionChange, children }: Modified & { selection?: T; onSelectionChange?: (value: T) => void }) {
  const options = Children.toArray(children).filter(isValidElement) as ReactElement<Modified>[];
  return createElement(
    "div",
    { role: "group" },
    options.map((option) => {
      const value = read(option.props.modifiers, "tag") as T;
      return createElement("button", { key: String(value), role: "menuitemradio", "aria-checked": value === selection, onClick: () => onSelectionChange?.(value) }, option.props.children);
    }),
  );
}

export function Button({ role, label, onPress, modifiers }: Modified & { role?: string; label?: string; onPress?: () => void }) {
  return createElement("button", { "aria-label": spoken(modifiers) ?? label ?? (role === "close" ? "Close" : undefined), onClick: onPress }, label);
}

export const accessibilityLabel = modifier("accessibilityLabel");
export const accessibilityValue = modifier("accessibilityValue");
export const buttonBorderShape = modifier("buttonBorderShape");
export const buttonStyle = modifier("buttonStyle");
export const controlSize = modifier("controlSize");
export const dynamicTypeSize = modifier("dynamicTypeSize");
export const labelStyle = modifier("labelStyle");
export const pickerStyle = modifier("pickerStyle");
export const tag = modifier("tag");
export const tint = modifier("tint");

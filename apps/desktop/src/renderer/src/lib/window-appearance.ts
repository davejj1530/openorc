import { create } from "zustand";
import type { WindowAppearance } from "../../../shared/types";
import { toHex } from "./color";

const key = "openorc.transparentShell";
const amountKey = "openorc.shellTransparency";
const defaultTransparency = 35;
let theme: WindowAppearance["theme"] = "system";
let revision = 0;

function read(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function save(storageKey: string, value: string): boolean {
  try {
    localStorage.setItem(storageKey, value);
    return true;
  } catch {
    return false;
  }
}

function normalizeAmount(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : defaultTransparency;
}

function readAmount(): number {
  const value = read(amountKey);
  return value?.trim() ? normalizeAmount(Number(value)) : defaultTransparency;
}

/**
 * How much of the app's own ground covers the native material, for a transparency between 0 and 100. The material
 * underneath is itself dark, so a tint that fell in step with the slider kept the window looking opaque until the top
 * of its range. The tint falls off with the square instead, so the middle of the slider reads as frosted glass.
 */
export function shellTint(transparency: number): number {
  return Math.round((100 - transparency) ** 2 / 100);
}

function applyAmount(value: number): void {
  document.documentElement.style.setProperty("--shell-opacity", `${shellTint(value)}%`);
}

interface WindowAppearanceState {
  transparent: boolean;
  transparency: number;
  supported: boolean;
  reducedTransparency: boolean;
  failed: boolean;
  setTransparent: (transparent: boolean) => boolean;
  setTransparency: (transparency: number) => boolean;
}

export const useWindowAppearance = create<WindowAppearanceState>((set) => ({
  transparent: read(key) === "true",
  transparency: readAmount(),
  supported: false,
  reducedTransparency: false,
  failed: false,
  setTransparent(transparent) {
    const saved = save(key, String(transparent));
    set({ transparent });
    syncWindowAppearance(theme);
    return saved;
  },
  setTransparency(value) {
    const transparency = normalizeAmount(value);
    const saved = save(amountKey, String(transparency));
    set({ transparency });
    // Dragging only changes the tint; leave the native blur running without IPC per tick.
    applyAmount(transparency);
    return saved;
  },
}));

/** Enable the CSS cutout only after the native window has a translucent material. */
export function syncWindowAppearance(choice: WindowAppearance["theme"]): void {
  theme = choice;
  const request = ++revision;
  const root = document.documentElement;
  applyAmount(useWindowAppearance.getState().transparency);
  const api = window.openorc?.syncWindowAppearance;
  if (!api) return;
  const background = toHex(root.style.getPropertyValue("--bg")) ?? "#1c1c21";
  void api({ theme, transparent: useWindowAppearance.getState().transparent, background }).then(
    ({ supported, enabled, reducedTransparency }) => {
      if (request !== revision) return;
      root.dataset.transparentShell = String(enabled);
      useWindowAppearance.setState({ supported, reducedTransparency, failed: false });
    },
    () => {
      if (request !== revision) return;
      root.dataset.transparentShell = "false";
      useWindowAppearance.setState({ failed: true });
    },
  );
}

window.matchMedia("(prefers-reduced-transparency: reduce)").addEventListener("change", () => syncWindowAppearance(theme));
window.addEventListener("storage", (event) => {
  if (event.key === amountKey) {
    const transparency = readAmount();
    useWindowAppearance.setState({ transparency });
    applyAmount(transparency);
    return;
  }
  if (event.key !== null && event.key !== key) return;
  useWindowAppearance.setState({ transparent: read(key) === "true", transparency: readAmount() });
  syncWindowAppearance(theme);
});

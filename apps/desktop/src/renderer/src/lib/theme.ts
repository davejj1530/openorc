import { create } from "zustand";
import { syncWindowAppearance } from "./window-appearance";
import { themePresets, type Mode, type ThemePreset } from "./theme-palettes";
import { overridesFor, parseCustomColors, withColor, withoutColor, withoutOverrides, type CustomColors } from "./theme-custom";
export { themePresets, type ThemePreset } from "./theme-palettes";

export type ThemeChoice = "system" | "light" | "dark";

const keys = ["openorc.theme", "openorc.palette", "openorc.colors"];

export function parseChoice(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}
export function parsePreset(value: string | null): ThemePreset {
  return themePresets.find((preset) => preset.id === value)?.id ?? "openorc";
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
const media = window.matchMedia("(prefers-color-scheme: dark)");
function resolve(choice: ThemeChoice): Mode {
  if (choice !== "system") return choice;
  return media.matches ? "dark" : "light";
}
function apply(choice: ThemeChoice, preset: ThemePreset, custom: CustomColors): Mode {
  const resolved = resolve(choice);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.palette = preset;
  root.classList.toggle("dark", resolved === "dark");
  const colors = { ...themePresets.find((p) => p.id === preset)!.colors[resolved], ...overridesFor(custom, preset, resolved) };
  for (const [key, value] of Object.entries(colors)) root.style.setProperty(key, value);
  syncWindowAppearance(choice);
  return resolved;
}
interface ThemeState {
  choice: ThemeChoice;
  preset: ThemePreset;
  resolved: Mode;
  custom: CustomColors;
  set: (choice: ThemeChoice) => boolean;
  setPreset: (preset: ThemePreset) => boolean;
  /* Color edits land on the palette and appearance mode currently on screen. */
  setColor: (token: string, value: string) => boolean;
  resetColor: (token: string) => boolean;
  resetColors: () => boolean;
}
const choice = parseChoice(read("openorc.theme"));
const preset = parsePreset(read("openorc.palette"));
const custom = parseCustomColors(read("openorc.colors"));
export const useTheme = create<ThemeState>((set, get) => {
  const commit = (next: CustomColors): boolean => {
    const { choice, preset, custom } = get();
    if (next === custom) return true;
    const saved = save("openorc.colors", JSON.stringify(next));
    set({ custom: next, resolved: apply(choice, preset, next) });
    return saved;
  };
  return {
    choice,
    preset,
    custom,
    resolved: apply(choice, preset, custom),
    set: (choice) => {
      const saved = save("openorc.theme", choice);
      set({ choice, resolved: apply(choice, get().preset, get().custom) });
      return saved;
    },
    setPreset: (preset) => {
      const saved = save("openorc.palette", preset);
      set({ preset, resolved: apply(get().choice, preset, get().custom) });
      return saved;
    },
    setColor: (token, value) => {
      const { preset, resolved, custom } = get();
      return commit(withColor(custom, preset, resolved, token, value));
    },
    resetColor: (token) => {
      const { preset, resolved, custom } = get();
      return commit(withoutColor(custom, preset, resolved, token));
    },
    resetColors: () => {
      const { preset, resolved, custom } = get();
      return commit(withoutOverrides(custom, preset, resolved));
    },
  };
});
media.addEventListener("change", () => {
  const { choice, preset, custom } = useTheme.getState();
  if (choice === "system") useTheme.setState({ resolved: apply(choice, preset, custom) });
});
window.addEventListener("storage", (event) => {
  if (event.key !== null && !keys.includes(event.key)) return;
  const choice = parseChoice(read("openorc.theme"));
  const preset = parsePreset(read("openorc.palette"));
  const custom = parseCustomColors(read("openorc.colors"));
  useTheme.setState({ choice, preset, custom, resolved: apply(choice, preset, custom) });
});

import { create } from "zustand";
import { platform } from "./this-computer";

/** The interface typefaces. fonts.css maps each id to its family. */
export const appFonts = [
  { id: "immaculate-gothic", name: "Immaculate Gothic" },
  { id: "inter", name: "Inter" },
  { id: "geist", name: "Geist" },
  { id: "pp-neue-montreal", name: "PP Neue Montreal" },
  { id: "system", name: "System" },
] as const;

export type AppFont = (typeof appFonts)[number]["id"];

const key = "openorc.font";

/** A Mac's own face leads there. Elsewhere the system face changes with the OS and the desktop, so the bundled one leads. */
const defaultFont: AppFont = platform === "darwin" ? "system" : "immaculate-gothic";

export function parseFont(value: string | null): AppFont {
  return appFonts.find((font) => font.id === value)?.id ?? defaultFont;
}

function read(): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function apply(font: AppFont): AppFont {
  document.documentElement.dataset.font = font;
  return font;
}

interface AppFontState {
  font: AppFont;
  setFont: (font: AppFont) => boolean;
}

export const useAppFont = create<AppFontState>((set) => ({
  font: apply(parseFont(read())),
  setFont(font) {
    const saved = save(font);
    set({ font: apply(font) });
    return saved;
  },
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useAppFont.setState({ font: apply(parseFont(read())) });
});

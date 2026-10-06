import { create } from "zustand";

/** The interface typefaces. fonts.css maps each id to its family. */
export const appFonts = [
  { id: "immaculate-gothic", name: "Immaculate Gothic" },
  { id: "inter", name: "Inter" },
  { id: "geist", name: "Geist" },
  { id: "system", name: "System" },
] as const;

export type AppFont = (typeof appFonts)[number]["id"];

const key = "openorc.font";

export function parseFont(value: string | null): AppFont {
  return appFonts.find((font) => font.id === value)?.id ?? "immaculate-gothic";
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

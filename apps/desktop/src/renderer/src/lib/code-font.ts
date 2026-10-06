import { create } from "zustand";

/** Independent of the interface face. code-fonts.css maps these ids to --font-mono. */
export const codeFonts = [
  { id: "jetbrains-mono", name: "JetBrains Mono" },
  { id: "geist-mono", name: "Geist Mono" },
  { id: "system", name: "System monospace" },
] as const;

export type CodeFont = (typeof codeFonts)[number]["id"];

const key = "openorc.code-font";

export function parseCodeFont(value: string | null): CodeFont {
  return codeFonts.find((font) => font.id === value)?.id ?? "jetbrains-mono";
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

function apply(font: CodeFont): CodeFont {
  document.documentElement.dataset.codeFont = font;
  return font;
}

interface CodeFontState {
  font: CodeFont;
  setFont: (font: CodeFont) => boolean;
}

export const useCodeFont = create<CodeFontState>((set) => ({
  font: apply(parseCodeFont(read())),
  setFont(font) {
    const saved = save(font);
    set({ font: apply(font) });
    return saved;
  },
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useCodeFont.setState({ font: apply(parseCodeFont(read())) });
});

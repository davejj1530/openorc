import { create } from "zustand";

/** The interface text sizes. text-size.css sets the type and leading scales for each one but Default. */
export const textSizes = [
  { id: "small", name: "Small" },
  { id: "default", name: "Default" },
] as const;

export type TextSize = (typeof textSizes)[number]["id"];

/** xterm draws its own cells, so the terminal takes its size from here instead of the scales. */
export const terminalFontSize: Record<TextSize, number> = { small: 12, default: 14 };

const key = "openorc.text-size";

export function parseTextSize(value: string | null): TextSize {
  return textSizes.find((size) => size.id === value)?.id ?? "default";
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

function apply(size: TextSize): TextSize {
  document.documentElement.dataset.textSize = size;
  return size;
}

interface TextSizeState {
  size: TextSize;
  setSize: (size: TextSize) => boolean;
}

export const useTextSize = create<TextSizeState>((set) => ({
  size: apply(parseTextSize(read())),
  setSize(size) {
    const saved = save(size);
    set({ size: apply(size) });
    return saved;
  },
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useTextSize.setState({ size: apply(parseTextSize(read())) });
});

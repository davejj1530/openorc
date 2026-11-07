import { create } from "zustand";

const key = "openorc.word-wrap";

/** Long lines of code wrap to the view unless the reader turned that off. */
function read(): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function save(wrap: boolean): void {
  try {
    localStorage.setItem(key, wrap ? "on" : "off");
  } catch {
    // private mode; the choice lasts for this session only
  }
}

interface WordWrapState {
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
}

/** One choice for every code view, the file editor and the panel's diffs alike. */
export const useWordWrap = create<WordWrapState>((set) => ({
  wrap: read(),
  setWrap(wrap) {
    save(wrap);
    set({ wrap });
  },
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useWordWrap.setState({ wrap: read() });
});

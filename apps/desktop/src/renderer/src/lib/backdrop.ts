import { create } from "zustand";

/** The dithering shader's own shapes, as the backdrop offers them. */
export const backdropPatterns = [
  { id: "sphere", name: "Sphere" },
  { id: "swirl", name: "Swirl" },
  { id: "warp", name: "Warp" },
  { id: "wave", name: "Waves" },
  { id: "ripple", name: "Ripple" },
  { id: "dots", name: "Dots" },
  { id: "simplex", name: "Noise" },
] as const;
export type BackdropPattern = (typeof backdropPatterns)[number]["id"];

/** The dither's threshold grids, coarse to fine. */
export const backdropGrids = [
  { id: "random", name: "Random" },
  { id: "2x2", name: "2×2" },
  { id: "4x4", name: "4×4" },
  { id: "8x8", name: "8×8" },
] as const;
export type BackdropGrid = (typeof backdropGrids)[number]["id"];

/** What the new thread screen draws behind itself: nothing, a moving pattern, or the user's own image. */
export type BackdropStyle = "off" | BackdropPattern | "image";

export interface Backdrop {
  style: BackdropStyle;
  /** The user's image as a data URL, kept while another style shows so choosing it again needs no new upload. */
  image: string | null;
  grid: BackdropGrid;
  /** The dots' size in pixels. */
  size: number;
  /** How fast a pattern moves, 0 to 100; images hold still. */
  motion: number;
}

/** Everything but the image: small enough to save on every slider step. */
type Settings = Omit<Backdrop, "image">;

export const backdropLimits = { size: { min: 1, max: 6 }, motion: { min: 0, max: 100 } } as const;

// Plain until chosen: the patterns are there to turn on in Settings.
const DEFAULT: Backdrop = { style: "off", image: null, grid: "4x4", size: 2, motion: 12 };
const KEY = "openorc.backdrop";
/** The image keeps its own entry, rewritten only when one is chosen or removed. */
const IMAGE_KEY = "openorc.backdrop.image";

type Entry = Partial<Record<keyof Backdrop, unknown>>;

const clamp = (value: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const oneOf = <T extends string>(value: unknown, options: readonly { id: T }[], fallback: T): T => options.find((option) => option.id === value)?.id ?? fallback;
const isImage = (value: unknown): value is string => typeof value === "string" && value.startsWith("data:image/");

function entryOf(raw: string | null): Entry {
  try {
    return (JSON.parse(raw ?? "{}") as Entry | null) ?? {};
  } catch {
    // An unreadable entry starts from the default.
    return {};
  }
}

/** A backdrop read field by field, so an old or damaged entry keeps whatever still makes sense. */
function backdropOf(value: Entry, image: unknown): Backdrop {
  const kept = isImage(image) ? image : null;
  const styles = [{ id: "off" as const }, ...backdropPatterns, ...(kept ? [{ id: "image" as const }] : [])];
  return {
    style: oneOf<BackdropStyle>(value.style, styles, DEFAULT.style),
    image: kept,
    grid: oneOf(value.grid, backdropGrids, DEFAULT.grid),
    size: clamp(value.size, backdropLimits.size, DEFAULT.size),
    motion: clamp(value.motion, backdropLimits.motion, DEFAULT.motion),
  };
}

/** A saved backdrop from its settings entry and its image entry. */
export function parseBackdrop(settings: string | null, image: string | null): Backdrop {
  return backdropOf(entryOf(settings), image);
}

const settingsOf = ({ style, grid, size, motion }: Settings): Settings => ({ style, grid, size, motion });

/** Whether a chosen image was kept for the next launch, and if not, whether storage was full or out of reach. */
export type BackdropSaved = "saved" | "full" | "unavailable";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSettings(backdrop: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(settingsOf(backdrop)));
    return true;
  } catch {
    return false;
  }
}

function saveImage(image: string | null): BackdropSaved {
  try {
    // The old image goes first, so a new one that fails to fit leaves none rather than the one it replaced.
    localStorage.removeItem(IMAGE_KEY);
    if (image) localStorage.setItem(IMAGE_KEY, image);
    return "saved";
  } catch (error) {
    return error instanceof DOMException && error.name === "QuotaExceededError" ? "full" : "unavailable";
  }
}

/** The saved backdrop. An entry from before the image had its own key still holds it, and it moves out here, once. */
function load(): Backdrop {
  const raw = read(KEY);
  const entry = entryOf(raw);
  if (!isImage(entry.image)) return backdropOf(entry, read(IMAGE_KEY));
  const backdrop = backdropOf(entry, entry.image);
  // The settings shrink first, freeing the space the image needs in its own entry.
  if (saveSettings(backdrop)) saveImage(backdrop.image);
  return backdrop;
}

interface BackdropState extends Backdrop {
  /** Applies a change and reports whether it was saved for the next launch. */
  change: (patch: Partial<Settings>) => boolean;
  /** Takes an image as the backdrop, dithered from now on. */
  chooseImage: (image: string) => BackdropSaved;
  /** Forgets the image; a backdrop showing it goes back to plain. */
  removeImage: () => boolean;
}

export const useBackdrop = create<BackdropState>((set, get) => {
  const change = (patch: Partial<Settings>) => {
    const next = backdropOf({ ...settingsOf(get()), ...patch }, get().image);
    set(next);
    return saveSettings(next);
  };
  return {
    ...load(),
    change,
    chooseImage: (image) => {
      const kept = saveImage(image);
      set({ image });
      return change({ style: "image" }) ? kept : "unavailable";
    },
    removeImage: () => {
      const kept = saveImage(null);
      set({ image: null });
      return change(get().style === "image" ? { style: DEFAULT.style } : {}) && kept === "saved";
    },
  };
});

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== KEY && event.key !== IMAGE_KEY) return;
  // A settings change leaves the image as it is; only a change to the image reads it again.
  const image = event.key === KEY ? useBackdrop.getState().image : read(IMAGE_KEY);
  useBackdrop.setState(parseBackdrop(read(KEY), image));
});

/** The longest side an image keeps: the dither drops finer detail, and a smaller copy is quicker to save and load. */
const IMAGE_SIDE = 1280;

/** A chosen file as a data URL small enough to keep, or null when it is not an image the window can draw. */
export async function backdropImage(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.85);
}

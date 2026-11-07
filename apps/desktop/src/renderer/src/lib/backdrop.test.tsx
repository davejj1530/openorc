import { beforeEach, expect, it, vi } from "vitest";
import { parseBackdrop } from "./backdrop";

const image = "data:image/webp;base64,AAAA";
const SETTINGS = "openorc.backdrop";
const IMAGE = "openorc.backdrop.image";

/** The backdrop as a fresh launch reads it from what storage holds now. */
async function launch() {
  vi.resetModules();
  return (await import("./backdrop")).useBackdrop;
}

/** Storage that refuses the image for its size and takes everything else. */
function fillStorageForImages() {
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === IMAGE) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    setItem.call(this, key, value);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("starts plain when nothing is saved or the entry cannot be read", () => {
  const fallback = { style: "off", image: null, imageColors: false, grid: "4x4", size: 2, motion: 12 };
  expect(parseBackdrop(null, null)).toEqual(fallback);
  expect(parseBackdrop("{not json", null)).toEqual(fallback);
});

it("keeps what still makes sense in a damaged entry, clamping the sliders into range", () => {
  expect(parseBackdrop(JSON.stringify({ style: "swirl", grid: "16x16", size: 40, motion: -5 }), null)).toMatchObject({ style: "swirl", grid: "4x4", size: 6, motion: 0 });
});

it("shows an image only while one is kept, and only an image data URL counts as one", () => {
  expect(parseBackdrop(JSON.stringify({ style: "image", imageColors: true }), image)).toMatchObject({ style: "image", image, imageColors: true });
  expect(parseBackdrop(JSON.stringify({ style: "image" }), null)).toMatchObject({ style: "off", image: null });
  expect(parseBackdrop(JSON.stringify({ style: "image" }), "https://example.com/picture.png")).toMatchObject({ style: "off", image: null });
});

it("keeps the image under its own key, so a slider step saves only the small settings", async () => {
  const backdrop = await launch();
  expect(backdrop.getState().chooseImage(image)).toBe("saved");
  expect(localStorage.getItem(IMAGE)).toBe(image);
  expect(JSON.parse(localStorage.getItem(SETTINGS) ?? "")).toEqual({ style: "image", imageColors: false, grid: "4x4", size: 2, motion: 12 });

  const writes = vi.spyOn(Storage.prototype, "setItem");
  expect(backdrop.getState().change({ size: 4 })).toBe(true);
  expect(writes.mock.calls.map(([key]) => key)).toEqual([SETTINGS]);
  expect((await launch()).getState()).toMatchObject({ style: "image", image, size: 4 });
});

it("moves the image out of a settings entry saved before it had its own key", async () => {
  localStorage.setItem(SETTINGS, JSON.stringify({ style: "image", image, imageColors: true, grid: "8x8", size: 3, motion: 40 }));
  expect((await launch()).getState()).toMatchObject({ style: "image", image, imageColors: true, grid: "8x8", size: 3, motion: 40 });
  expect(localStorage.getItem(IMAGE)).toBe(image);
  expect(JSON.parse(localStorage.getItem(SETTINGS) ?? "")).toEqual({ style: "image", imageColors: true, grid: "8x8", size: 3, motion: 40 });
  expect((await launch()).getState()).toMatchObject({ style: "image", image });
});

it("shows an image too large to save for this session only, and keeps saving every other change", async () => {
  const backdrop = await launch();
  backdrop.getState().chooseImage(image);
  fillStorageForImages();
  const larger = "data:image/webp;base64,BBBB";

  expect(backdrop.getState().chooseImage(larger)).toBe("full");
  expect(backdrop.getState()).toMatchObject({ style: "image", image: larger });
  expect(backdrop.getState().change({ motion: 30 })).toBe(true);
  expect((await launch()).getState()).toMatchObject({ style: "off", image: null, motion: 30 });
});

it("forgets a removed image, and a backdrop showing it goes back to plain", async () => {
  const backdrop = await launch();
  backdrop.getState().chooseImage(image);
  expect(backdrop.getState().removeImage()).toBe(true);
  expect(backdrop.getState()).toMatchObject({ style: "off", image: null });
  expect(localStorage.getItem(IMAGE)).toBeNull();
});

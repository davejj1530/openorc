import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installImageContextMenu } from "./image-context-menu";

const native = vi.hoisted(() => ({ menu: vi.fn(), popup: vi.fn(), save: vi.fn(), error: vi.fn() }));
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: native.menu },
  dialog: { showSaveDialog: native.save, showMessageBox: native.error },
}));

let dir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(join(tmpdir(), "openorc-image-menu-"));
  native.menu.mockReturnValue({ popup: native.popup });
  native.save.mockResolvedValue({ canceled: false, filePath: join(dir, "download") });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture() {
  const contents = Object.assign(new EventEmitter(), { copyImageAt: vi.fn(), isDestroyed: vi.fn(() => false) });
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  installImageContextMenu(window as unknown as BrowserWindow, dir);
  return {
    contents,
    window,
    open(source: string, params = {}) {
      contents.emit("context-menu", {}, { mediaType: "image", hasImageContents: true, srcURL: source, x: 23, y: 41, ...params });
    },
    click(label: string) {
      const items: MenuItemConstructorOptions[] = native.menu.mock.lastCall![0];
      const item = items.find((item) => item.label === label)!;
      (item.click as () => void)();
    },
  };
}

it("offers a native image menu and copies at Chromium's image coordinates", () => {
  const ui = fixture();
  ui.open("data:image/png;base64,aGVsbG8=");
  expect(native.menu.mock.lastCall![0].map((item: MenuItemConstructorOptions) => item.label)).toEqual(["Copy image", "Download image…"]);
  expect(native.popup).toHaveBeenCalledWith({ window: ui.window });
  ui.click("Copy image");
  expect(ui.contents.copyImageAt).toHaveBeenCalledExactlyOnceWith(23, 41);
  ui.contents.isDestroyed.mockReturnValue(true);
  ui.click("Copy image");
  expect(ui.contents.copyImageAt).toHaveBeenCalledTimes(1);
});

it("downloads stored attachments without changing their encoding", async () => {
  await mkdir(join(dir, "attachments"));
  const bytes = Buffer.from("original GIF bytes");
  await writeFile(join(dir, "attachments", "abc-123.gif"), bytes);
  const ui = fixture();
  ui.open("openorc-asset://attachments/abc-123.gif");
  ui.click("Download image…");
  await vi.waitFor(async () => expect(await readFile(join(dir, "download"))).toEqual(bytes));
});

it("downloads a tool's stored image under its own file name", async () => {
  await mkdir(join(dir, "tool-images", "run-1"), { recursive: true });
  const bytes = Buffer.from("stored PNG bytes");
  await writeFile(join(dir, "tool-images", "run-1", "abc-123.png"), bytes);
  const ui = fixture();
  ui.open("openorc-asset://tool-images/run-1/abc-123.png");
  ui.click("Download image…");
  await vi.waitFor(async () => expect(await readFile(join(dir, "download"))).toEqual(bytes));
  expect(native.save.mock.lastCall![1].defaultPath).toBe("abc-123.png");
});

it.each(["png"])("downloads inline %s image bytes with the matching extension", async (format) => {
  const ui = fixture();
  const bytes = Buffer.from([0, 1, 127, 255]);
  ui.open(`data:image/${format};base64,${bytes.toString("base64")}`);
  ui.click("Download image…");
  await vi.waitFor(async () => expect(await readFile(join(dir, "download"))).toEqual(bytes));
  expect(native.save.mock.lastCall![1].defaultPath).toBe(`image.${format === "jpeg" ? "jpg" : format}`);
});

it("leaves an existing destination untouched when saving is cancelled", async () => {
  await writeFile(join(dir, "download"), "existing");
  native.save.mockResolvedValue({ canceled: true, filePath: join(dir, "download") });
  const ui = fixture();
  ui.open("openorc-asset://local-image/?path=/missing.png");
  ui.click("Download image…");
  await new Promise((resolve) => setImmediate(resolve));
  expect(await readFile(join(dir, "download"), "utf8")).toBe("existing");
  expect(native.error).not.toHaveBeenCalled();
});

it.each(["openorc-asset://local-image/?path=/missing.png", "data:image/png;base64,@@@", `data:image/png;base64,${"A".repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 1)}`])(
  "reports unavailable, malformed or oversized image data without truncating the destination",
  async (source) => {
    await writeFile(join(dir, "download"), "existing");
    const ui = fixture();
    ui.open(source);
    ui.click("Download image…");
    await vi.waitFor(() => expect(native.error).toHaveBeenCalledWith(ui.window, expect.objectContaining({ message: "Could not download image" })));
    expect(await readFile(join(dir, "download"), "utf8")).toBe("existing");
  },
);

it("reports destination write failures", async () => {
  native.save.mockResolvedValue({ canceled: false, filePath: join(dir, "missing", "image.png") });
  const ui = fixture();
  ui.open("data:image/png;base64,aGVsbG8=");
  ui.click("Download image…");
  await vi.waitFor(() => expect(native.error).toHaveBeenCalledWith(ui.window, expect.objectContaining({ message: "Could not download image" })));
});

it("ignores non-images, unloaded images and sources outside the image boundary", () => {
  const ui = fixture();
  ui.open("data:image/png;base64,aGVsbG8=", { mediaType: "none" });
  ui.open("data:image/png;base64,aGVsbG8=", { hasImageContents: false });
  for (const source of [
    "https://example.com/image.png",
    "file:///tmp/image.png",
    "data:text/html;base64,aGVsbG8=",
    "openorc-asset://attachments/..%2Fsecret.png",
    "openorc-asset://local-image/?path=/tmp/secret.txt",
  ])
    ui.open(source);
  expect(native.menu).not.toHaveBeenCalled();
});

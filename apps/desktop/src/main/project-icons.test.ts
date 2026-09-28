import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectIcons } from "./project-icons";
import { discoverProjectIcons, readSmallFile, ICON_SCAN_LIMITS } from "./project-icon-discovery";
import { detectProjectStack } from "./project-stack";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "project-icons-"));
  dirs.push(dir);
  const root = path.join(dir, "repo");
  await mkdir(root);
  const add = async (file: string, content = "image") => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const preview = vi.fn(async (file: string) => ({ dataUrl: `data:image/png;base64,${Buffer.from(file).toString("base64")}`, square: true }));
  const cache = path.join(dir, "cache");
  const detect = vi.fn(detectProjectStack);
  return { dir, root, cache, add, preview, detect, service: new ProjectIcons(cache, preview, detect) };
}

it("finds declared and conventional icons in a monorepo without traversing dependencies, output or symlinks", async () => {
  const f = await fixture();
  await f.add("apps/desktop/electron-builder.yml", "mac:\n  icon: missing.icns\nlinux:\n  icon: resources/brand.png\n");
  await f.add("apps/desktop/resources/brand.png");
  await f.add("apps/site/public/favicon.png");
  await f.add("apps/desktop/src/renderer/assets/product-mark.png");
  await f.add("node_modules/pkg/icon.png");
  await f.add("dist/icon.png");
  const outside = path.join(f.dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "icon.png"), "external");
  await symlink(outside, path.join(f.root, "assets"));
  const found = await discoverProjectIcons(f.root);
  expect(found).toContainEqual({ path: "apps/desktop/resources/brand.png", score: 100 });
  expect(found.map((icon) => icon.path)).toEqual(expect.arrayContaining(["apps/site/public/favicon.png", "apps/desktop/src/renderer/assets/product-mark.png"]));
  expect(found).toHaveLength(3);
});

it("honors manifest icons but ignores external paths and never executes config files", async () => {
  const f = await fixture();
  await f.add("assets/brand.png");
  await f.add("package.json", JSON.stringify({ build: { linux: { icon: "assets/brand.png" } } }));
  await f.add("manifest.json", JSON.stringify({ icons: [{ src: "https://example.com/icon.png" }, { src: "../secret.png" }] }));
  await f.add("electron-builder.cjs", "throw new Error('Do not execute');");
  expect(await discoverProjectIcons(f.root)).toEqual([{ path: "assets/brand.png", score: 100 }]);
  await f.add("large.json", "a".repeat(1025));
  await expect(readSmallFile(path.join(f.root, "large.json"), 1024)).rejects.toThrow("size limit");
});

it("bounds directory discovery and candidate decoding", async () => {
  const f = await fixture();
  for (let index = 0; index < 80; index++) await f.add(`apps/package-${index}/icon.png`);
  const discovered = await discoverProjectIcons(f.root);
  expect(discovered.length).toBeLessThanOrEqual(ICON_SCAN_LIMITS.directories - 2);
  const state = await f.service.get(f.root);
  expect(f.preview).toHaveBeenCalledTimes(12);
  expect(state.candidates).toHaveLength(6);
  expect(state.selected).toBeNull(); // Equally plausible apps require a user choice.
});

it("coalesces concurrent reads and reuses thumbnails across reads and restarts", async () => {
  const f = await fixture();
  await f.add("resources/icon.png");
  const [one, two] = await Promise.all([f.service.get(f.root), f.service.get(f.root)]);
  expect(one).toEqual(two);
  expect(one.selected?.path).toBe("resources/icon.png");
  expect(f.preview).toHaveBeenCalledTimes(1);
  await f.service.get(f.root);
  const reopened = new ProjectIcons(f.cache, f.preview);
  expect(await reopened.get(f.root)).toEqual(one);
  expect(f.preview).toHaveBeenCalledTimes(1);
});

it("persists negative results until explicitly refreshed", async () => {
  const f = await fixture();
  expect((await f.service.get(f.root)).candidates).toEqual([]);
  await f.add("icon.png");
  const reopened = new ProjectIcons(f.cache, f.preview);
  expect((await reopened.get(f.root)).candidates).toEqual([]);
  expect(f.preview).not.toHaveBeenCalled();
  expect((await reopened.refresh(f.root)).selected?.path).toBe("icon.png");
});

it.each([null, "logo.png"])("rescans an old automatic cache once to recover ICOs (previous choice: %s)", async (previous) => {
  const f = await fixture();
  await f.add("app/favicon.ico");
  await f.add("logo.png");
  await mkdir(f.cache);
  const file = path.join(f.cache, `${createHash("sha256").update(f.root).digest("hex")}.json`);
  const selected = previous ? { path: previous, dataUrl: "data:image/png;base64,bG9nbw==" } : null;
  await writeFile(file, JSON.stringify({ version: 1, rootPath: f.root, mode: "auto", selected, candidates: selected ? [selected] : [] }));
  expect((await f.service.get(f.root)).selected?.path).toBe("app/favicon.ico");
  expect(f.preview).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 3 });
  expect((await new ProjectIcons(f.cache, f.preview).get(f.root)).selected?.path).toBe("app/favicon.ico");
  expect(f.preview).toHaveBeenCalledTimes(2);
});

it.each(["manual", "folder"])("preserves an old %s choice without rescanning", async (mode) => {
  const f = await fixture();
  await f.add("app/favicon.ico");
  await mkdir(f.cache);
  const file = path.join(f.cache, `${createHash("sha256").update(f.root).digest("hex")}.json`);
  const selected = mode === "manual" ? { path: "logo.png", dataUrl: "data:image/png;base64,bG9nbw==" } : null;
  await writeFile(file, JSON.stringify({ version: 1, rootPath: f.root, mode, selected, candidates: [] }));
  expect(await f.service.get(f.root)).toMatchObject({ mode, selected });
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.detect).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 3 });
});

it("respects manual/folder choices during refresh and concurrent actions", async () => {
  const f = await fixture();
  await f.add("icon.png");
  await f.add("logo.png");
  await f.service.get(f.root);
  await Promise.all([f.service.choose(f.root, { mode: "manual", path: "logo.png" }), f.service.refresh(f.root)]);
  expect((await f.service.get(f.root)).selected?.path).toBe("logo.png");
  await f.service.choose(f.root, { mode: "folder" });
  expect(await f.service.refresh(f.root)).toMatchObject({ mode: "folder", selected: null });
  expect(await new ProjectIcons(f.cache, f.preview).get(f.root)).toMatchObject({ mode: "folder", selected: null });
  expect((await f.service.choose(f.root, { mode: "auto" })).selected?.path).toBe("icon.png");
  await expect(f.service.choose(f.root, { mode: "manual", path: "../secret.png" })).rejects.toThrow("no longer available");
});

it("refreshes a missing automatic source on restart and retains manually imported thumbnails", async () => {
  const f = await fixture();
  await f.add("icon.png");
  await f.service.get(f.root);
  await rm(path.join(f.root, "icon.png"));
  const reopened = new ProjectIcons(f.cache, f.preview);
  expect((await reopened.get(f.root)).selected).toBeNull();
  const custom = await reopened.pick(f.root, path.join(f.dir, "chosen.png"));
  expect(custom.mode).toBe("manual");
  expect(await new ProjectIcons(f.cache, f.preview).get(f.root)).toEqual(custom);
});

it("skips failed decodes, prefers square icons and deduplicates identical previews", async () => {
  const f = await fixture();
  await f.add("icon-broken.png");
  await f.add("icon-wide.png");
  await f.add("favicon.png");
  await f.add("logo.png");
  const preview = vi.fn(async (file: string) => {
    if (file.includes("broken")) throw Error("Corrupt image");
    return { dataUrl: "data:image/png;base64," + (file.includes("wide") ? "d2lkZQ==" : "c3F1YXJl"), square: !file.includes("wide") };
  });
  const state = await new ProjectIcons(f.cache, preview).get(f.root);
  expect(state.selected?.path).toBe("favicon.png");
  expect(state.candidates).toHaveLength(2);
});

it("caches a bundled icon ID across concurrent reads and restarts without rereading metadata", async () => {
  const f = await fixture();
  await f.add("package.json", JSON.stringify({ dependencies: { "@nestjs/core": "11", express: "5" } }));
  const states = await Promise.all(Array.from({ length: 100 }, () => f.service.get(f.root)));
  expect(states.every((state) => state.fallback === "nestjs" && state.selected === null)).toBe(true);
  expect(f.detect).toHaveBeenCalledTimes(1);
  expect(f.preview).not.toHaveBeenCalled();
  await rm(path.join(f.root, "package.json"));
  const reopened = new ProjectIcons(f.cache, f.preview, f.detect);
  expect((await reopened.get(f.root)).fallback).toBe("nestjs");
  expect(f.detect).toHaveBeenCalledTimes(1);
  expect((await reopened.refresh(f.root)).fallback).toBeNull();
  expect(f.detect).toHaveBeenCalledTimes(2);
});

it("caches negative stack detection and keeps repository images ahead of stack fallbacks", async () => {
  const f = await fixture();
  expect((await f.service.get(f.root)).fallback).toBeNull();
  await f.add("package.json", JSON.stringify({ dependencies: { react: "19" } }));
  const reopened = new ProjectIcons(f.cache, f.preview, f.detect);
  expect((await reopened.get(f.root)).fallback).toBeNull();
  expect(f.detect).toHaveBeenCalledTimes(1);
  await f.add("icon.png");
  expect(await reopened.refresh(f.root)).toMatchObject({ selected: { path: "icon.png" }, fallback: "react" });
});

it.each(["auto", "manual", "folder"])("upgrades a version-2 %s cache without decoding its images again", async (mode) => {
  const f = await fixture();
  await f.add("package.json", JSON.stringify({ dependencies: { react: "19" } }));
  await f.add("icon.png");
  await mkdir(f.cache);
  const selected = mode === "folder" ? null : { path: "icon.png", dataUrl: "data:image/png;base64,aWNvbg==" };
  const file = path.join(f.cache, `${createHash("sha256").update(f.root).digest("hex")}.json`);
  await writeFile(file, JSON.stringify({ version: 2, rootPath: f.root, mode, selected, candidates: [] }));
  const fallback = mode === "auto" ? "react" : null;
  expect(await f.service.get(f.root)).toMatchObject({ mode, selected, fallback });
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.detect).toHaveBeenCalledTimes(mode === "auto" ? 1 : 0);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 3, fallback });
});

it("rejects unknown cached stack IDs instead of handing them to the renderer", async () => {
  const f = await fixture();
  await mkdir(f.cache);
  const file = path.join(f.cache, `${createHash("sha256").update(f.root).digest("hex")}.json`);
  await writeFile(file, JSON.stringify({ version: 3, rootPath: f.root, mode: "auto", selected: null, candidates: [], fallback: "toString" }));
  expect((await f.service.get(f.root)).fallback).toBeNull();
  expect(f.detect).toHaveBeenCalledTimes(1);
});

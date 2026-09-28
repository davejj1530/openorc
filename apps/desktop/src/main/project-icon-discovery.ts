import { open, opendir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const ICON_SCAN_LIMITS = { directories: 64, entries: 4096, entriesPerDirectory: 256, manifests: 24, candidates: 64, depth: 5 };
const folders = new Set(["public", "assets", "static", "resources", "res", "images", "icons", "src", "renderer", "app", "src-tauri"]);
const containers = new Set(["apps", "packages"]);
const excluded = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "coverage"]);
const manifests = new Set(["package.json", "manifest.json", "site.webmanifest", "tauri.conf.json", "electron-builder.json", "electron-builder.yml", "electron-builder.yaml"]);
const imageName = /(?:^|[-_.])(icon|favicon|logo|mark)(?:[-_.]|$)/i;
export const ICON_EXTENSION = /\.(png|jpe?g|webp|ico|svg)$/i;

/** Read a fixed byte budget, even when the file grows while being read. */
export async function readSmallFile(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("File exceeds the icon size limit.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size || length > limit) throw new Error("File changed while reading its icon.");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function containedFile(root: string, file: string): Promise<string> {
  const resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Icon must be inside the repository.");
  return resolved;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function iconPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => iconPaths(item)).slice(0, 12);
  const record = object(value);
  return typeof record["src"] === "string" ? [record["src"]] : [];
}

/** Read declarative fields only. Never import/execute repository configuration. */
function declaredIcons(text: string, name: string): string[] {
  if (/\.ya?ml$/.test(name)) return [...text.matchAll(/^\s*icon:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/gm)].slice(0, 12).map((match) => match[1]!);
  const config = object(JSON.parse(text));
  const build = object(config["build"]);
  return [
    config["icons"],
    config["icon"],
    object(config["bundle"])["icon"],
    object(object(config["tauri"])["bundle"])["icon"],
    build["icon"],
    ...["mac", "win", "linux"].flatMap((os) => [object(build[os])["icon"], object(config[os])["icon"]]),
  ]
    .flatMap(iconPaths)
    .slice(0, 12);
}

interface SearchState {
  queue: { relative: string; depth: number }[];
  candidates: Map<string, number>;
  entries: number;
  manifests: number;
}

function addCandidate(state: SearchState, relative: string, score: number): void {
  if (!ICON_EXTENSION.test(relative) || (state.candidates.size >= ICON_SCAN_LIMITS.candidates && !state.candidates.has(relative))) return;
  state.candidates.set(relative, Math.max(score, state.candidates.get(relative) ?? 0));
}

async function readManifest(root: string, relative: string, state: SearchState): Promise<void> {
  if (state.manifests++ >= ICON_SCAN_LIMITS.manifests) return;
  try {
    const file = await containedFile(root, path.join(root, relative));
    const declarations = declaredIcons((await readSmallFile(file, 64 * 1024)).toString("utf8"), path.basename(relative));
    for (const icon of declarations) await addDeclared(root, relative, icon, state);
  } catch {
    // Missing/invalid manifests do not stop the conventional filename search.
  }
}

async function addDeclared(root: string, manifest: string, icon: string, state: SearchState): Promise<void> {
  if (!ICON_EXTENSION.test(icon) || /^(?:[a-z]+:|\/\/)/i.test(icon)) return;
  try {
    const target = path.resolve(root, path.dirname(manifest), icon.replace(/^\//, ""));
    addCandidate(state, path.relative(root, await containedFile(root, target)), 100);
  } catch {
    // A missing platform-specific image must not hide other declared icons.
  }
}

function filenameScore(name: string): number {
  if (/^(icon|favicon)(?:[-_.]|$)/i.test(name)) return 80;
  if (/(?:^|[-_.])mark(?:[-_.]|$)/i.test(name)) return 70;
  return 60;
}

function searchableDirectory(name: string, parent: string): boolean {
  if (name.startsWith(".") || excluded.has(name)) return false;
  return folders.has(name) || containers.has(name) || containers.has(parent);
}

async function visit(root: string, current: SearchState["queue"][number], state: SearchState): Promise<void> {
  try {
    const directory = await opendir(await containedFile(root, path.join(root, current.relative)));
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > ICON_SCAN_LIMITS.entriesPerDirectory || ++state.entries > ICON_SCAN_LIMITS.entries) break;
      const relative = path.join(current.relative, entry.name);
      if (entry.isFile()) {
        if (ICON_EXTENSION.test(entry.name) && imageName.test(entry.name)) addCandidate(state, relative, filenameScore(entry.name));
        if (manifests.has(entry.name)) await readManifest(root, relative, state);
      }
      if (entry.isDirectory() && current.depth < ICON_SCAN_LIMITS.depth && state.queue.length < ICON_SCAN_LIMITS.directories && searchableDirectory(entry.name, current.relative)) {
        state.queue.push({ relative, depth: current.depth + 1 });
      }
    }
  } catch {
    // Unreadable directories and symlinks outside the root are ignored.
  }
}

/** Bounded breadth-first search; no recursive walk through dependencies or build output. */
export async function discoverProjectIcons(rootPath: string): Promise<{ path: string; score: number }[]> {
  const root = await realpath(rootPath);
  const state: SearchState = { queue: [{ relative: "", depth: 0 }], candidates: new Map(), entries: 0, manifests: 0 };
  for (let index = 0; index < state.queue.length && index < ICON_SCAN_LIMITS.directories && state.entries < ICON_SCAN_LIMITS.entries; index++) {
    await visit(root, state.queue[index]!, state);
  }
  return [...state.candidates].map(([file, score]) => ({ path: file, score })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { WORKSPACE_ID, type Project } from "@openorc/protocol";
import { directory } from "../workspace-home.js";

/** Bounded local discovery. Symlinks and ignored/tool directories are never traversed. */
export async function folderCatalog(home: Project, imported: Project[]): Promise<Pick<Project, "id" | "name" | "rootPath">[]> {
  const root = await directory(home.rootPath);
  const catalog = [...imported, { id: WORKSPACE_ID, name: "Workspace", rootPath: root }];
  const known = new Set(await Promise.all(imported.map((p) => realpath(p.rootPath).catch(() => p.rootPath))));
  const queue = [{ folder: root, depth: 0 }];
  const skip = new Set(["node_modules", "vendor", "dist", "build", "target", "Library"]);
  let visited = 0;
  while (queue.length && visited < 250) {
    const next = queue.shift()!;
    const entries = await readdir(next.folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (visited >= 250) break;
      if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
      visited++;
      const folder = path.join(next.folder, entry.name);
      const resolved = await realpath(folder).catch(() => null);
      if (!resolved || !within(root, resolved)) continue;
      if (!known.has(resolved)) catalog.push({ id: folderId(resolved), name: entry.name, rootPath: resolved });
      known.add(resolved);
      if (next.depth < 2) queue.push({ folder: resolved, depth: next.depth + 1 });
    }
  }
  return catalog;
}
export function folderId(canonicalPath: string): string {
  return `folder:${createHash("sha256").update(canonicalPath).digest("hex")}`;
}
export function within(root: string, folder: string): boolean {
  const relative = path.relative(root, folder);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

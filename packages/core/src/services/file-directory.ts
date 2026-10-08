import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "@openorc/git";
import { FolderPath, type FileDirectory, type FileEntry } from "@openorc/protocol";

const HIDDEN_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

async function ignoredNames(directory: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const result = await git(directory, ["check-ignore", "-z", "--stdin"], { input: names.join("\0") + "\0", okCodes: [0, 1], timeoutMs: 5_000 }).catch(() => null);
  return new Set(result?.stdout.split("\0").filter(Boolean));
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Only reads immediate children. Resolving links never grants access outside the conversation's folder. */
export async function listDirectory(root: string, path: "" | FolderPath): Promise<FileDirectory> {
  const requested = resolve(root, path);
  if (!inside(root, requested)) throw new Error("This folder is outside the conversation's workspace.");
  const directory = await realpath(requested);
  if (!inside(root, directory)) throw new Error("This folder is outside the conversation's workspace.");
  const children = await readdir(directory, { withFileTypes: true });
  const ignored = new Set([
    ...HIDDEN_ENTRIES,
    ...(await ignoredNames(
      directory,
      children.map((child) => child.name),
    )),
  ]);
  const entries: FileEntry[] = [];
  for (const child of children) {
    let kind: FileEntry["kind"] = child.isDirectory() ? "directory" : "file";
    if (child.isSymbolicLink()) {
      const target = await realpath(join(directory, child.name)).catch(() => null);
      if (!target || !inside(root, target)) continue;
      const info = await stat(target).catch(() => null);
      if (!info || (!info.isDirectory() && !info.isFile())) continue;
      kind = info.isDirectory() ? "directory" : "file";
    } else if (!child.isDirectory() && !child.isFile()) continue;
    entries.push({ name: child.name, path: FolderPath.parse(path ? `${path}/${child.name}` : child.name), kind, ignored: ignored.has(child.name) });
  }
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { root, entries };
}

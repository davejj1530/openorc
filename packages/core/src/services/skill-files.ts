import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { skillFolderOf } from "@openorc/agents";
import { FolderPath, type AgentSkill, type FileVersion, type SkillFile, type SkillFileRead, type SkillFileWrite } from "@openorc/protocol";
import type { FileService } from "./files.js";

/** A skill folder holds a few dozen files; this bounds what a junk folder can cost a listing. */
const MAX_FILES = 500;
const MAX_DEPTH = 8;

/**
 * Where a skill's files are: its folder, by its real path, so every file is checked against where it really is. A
 * skill that is one Markdown file, as a command is, has that file alone.
 */
export interface SkillHome {
  root: string;
  only: string | null;
}

export async function skillHome(skill: Pick<AgentSkill, "path">): Promise<SkillHome> {
  const folder = skillFolderOf(skill.path);
  if (folder) return { root: await realpath(folder), only: null };
  if (!path.isAbsolute(skill.path)) throw new Error("This skill has no files on this Mac.");
  const file = await realpath(skill.path);
  return { root: path.dirname(file), only: path.basename(file) };
}

/** Whether `file` is inside `folder`, by path alone; callers compare real paths. */
export function within(folder: string, file: string): boolean {
  const local = path.relative(folder, file);
  return local !== "" && local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local);
}

const OUTSIDE = "This file is outside the skill's folder.";

/** A file's place in the skill's folder: relative, with no `..` and no hidden part, which listings leave out too. */
function skillFilePath(home: SkillHome, file: string): FolderPath {
  const parsed = FolderPath.safeParse(file);
  if (!parsed.success || file.includes("\\") || file.split("/").some((part) => part.startsWith("."))) throw new Error(OUTSIDE);
  if (home.only !== null && parsed.data !== home.only) throw new Error(OUTSIDE);
  return parsed.data;
}

/** An entry's kind, seen through a link only when the link stays inside the skill's folder. */
async function entryKind(root: string, file: string, link: boolean): Promise<SkillFile["kind"] | null> {
  const target = link ? await realpath(file).catch(() => null) : file;
  if (target === null || (link && !within(root, target))) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) return "directory";
  return info?.isFile() ? "file" : null;
}

/** The skill's files and folders, each folder followed by what it holds, in name order. A linked folder is not entered. */
export async function listSkillFiles(home: SkillHome): Promise<SkillFile[]> {
  if (home.only !== null) return [{ path: home.only, kind: "file" }];
  const found: SkillFile[] = [];
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((each) => !each.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      const file = path.join(dir, entry.name);
      const kind = await entryKind(home.root, file, entry.isSymbolicLink());
      if (!kind) continue;
      const local = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push({ path: local, kind });
      if (kind === "directory" && !entry.isSymbolicLink() && depth < MAX_DEPTH) await visit(file, local, depth + 1);
    }
  };
  await visit(home.root, "", 0);
  return found;
}

/** One of the skill's files as it is now. `readOnly` is why it can't be edited, or null. */
export async function readSkillFile(files: Pick<FileService, "read">, home: SkillHome, file: string, readOnly: string | null): Promise<SkillFileRead> {
  const local = skillFilePath(home, file);
  const target = await realpath(path.join(home.root, local)).catch(() => null);
  if (target !== null && !within(home.root, target)) throw new Error(OUTSIDE);
  const read = await files.read({ root: home.root, readOnly }, local);
  if (read.kind === "file") return { kind: "text", text: read.text, version: read.version, readOnly: read.readOnly };
  if (read.kind === "binary") return { kind: "binary", bytes: read.size };
  if (read.kind === "missing") return { kind: "missing" };
  return { kind: "unreadable", reason: read.reason };
}

/** Saves one of the skill's files where it really is, a link inside the folder followed, only while it is still as `expected`. */
export async function writeSkillFile(files: Pick<FileService, "read" | "save">, home: SkillHome, file: string, text: string, expected: FileVersion): Promise<SkillFileWrite> {
  const local = skillFilePath(home, file);
  const target = await realpath(path.join(home.root, local)).catch(() => null);
  if (target === null) return { kind: "conflict", current: { kind: "missing" } };
  if (!within(home.root, target)) throw new Error(OUTSIDE);
  const real = FolderPath.parse(path.relative(home.root, target).split(path.sep).join("/"));
  const outcome = await files.save(home.root, real, text, { kind: "version", version: expected });
  if (outcome.kind === "written") return { kind: "saved", version: outcome.version };
  return { kind: "conflict", current: await readSkillFile(files, home, local, null) };
}

import { randomUUID } from "node:crypto";
import { chmod, copyFile, constants, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SKILL_ICON_BYTES, SHARED_CLAUDE_CONFIG_DIR, SKILL_ICON_TYPES, SKILL_INTERFACE_FILE, claudeConfigDir, newSkillText, skillFolderOf, withSkillIcon } from "@openorc/agents";
import { FolderPath, SkillName, type AgentSkill, type HarnessId, type SkillFile, type SkillPlace } from "@openorc/protocol";
import { versionOf } from "./file-write.js";
import type { FileService } from "./files.js";
import { assertSafeParentPath } from "./safe-parent-path.js";
import { within } from "./skill-files.js";

/** Where each agent finds a project's skills, from the project's folder. */
const PROJECT_SKILLS: Record<HarnessId, string> = { claude: ".claude/skills", codex: ".agents/skills", opencode: ".opencode/skills" };

/**
 * The folder a new skill goes in, one the agent lists skills from. A Claude account added in OpenOrc gets the CLI
 * login's personal skills linked into its own folder, so a personal skill goes there and reaches every account.
 */
export function skillPlace(agent: HarnessId, place: SkillPlace, projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (place === "project") return path.join(projectRoot, PROJECT_SKILLS[agent]);
  const home = os.homedir();
  if (agent === "claude") return path.join(env[SHARED_CLAUDE_CONFIG_DIR] || claudeConfigDir(home, env), "skills");
  if (agent === "codex") return path.join(home, ".agents", "skills");
  return path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "opencode", "skills");
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

const taken = (name: string) => new Error(`A skill named ${name} is already there.`);

/** Writes a new skill's folder and SKILL.md in `place`; a folder already there is never touched. */
export async function createSkill(place: string, name: string, description: string, instructions: string): Promise<string> {
  const folder = path.join(place, name);
  await mkdir(place, { recursive: true });
  await mkdir(folder).catch((error: NodeJS.ErrnoException) => Promise.reject(error.code === "EEXIST" ? taken(name) : error));
  await writeFile(path.join(folder, "SKILL.md"), newSkillText(name, description, instructions), { flag: "wx" });
  return folder;
}

/** A skill folder this large is not one; the cap keeps a wrong choice, like a home folder, from copying for minutes. */
const MAX_IMPORT_FILES = 1000;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 8;

/**
 * Copies `root`'s files into `to`, leaving out hidden entries and links that lead outside it. A linked folder inside it
 * is copied as a folder, unless it leads back up the tree.
 */
async function copySkillTree(root: string, to: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const tooLarge = new Error("This folder is too large to be a skill.");
  const copy = async (dir: string, target: string, depth: number): Promise<void> => {
    if (depth > MAX_IMPORT_DEPTH) throw tooLarge;
    await mkdir(target);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const real = await realpath(path.join(dir, entry.name)).catch(() => null);
      if (real === null || !within(root, real)) continue;
      const info = await stat(real);
      if (info.isDirectory()) {
        if (real !== dir && !within(real, dir)) await copy(real, path.join(target, entry.name), depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      files += 1;
      bytes += info.size;
      if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) throw tooLarge;
      await copyFile(real, path.join(target, entry.name), constants.COPYFILE_EXCL);
      await chmod(path.join(target, entry.name), info.mode & 0o777);
    }
  };
  await copy(root, to, 0);
}

/**
 * Copies a folder holding a SKILL.md into `place`, named by its folder. It is copied beside the destination under a
 * hidden name, which no agent lists, and renamed into place once whole.
 */
export async function importSkill(place: string, from: string): Promise<string> {
  if (!path.isAbsolute(from)) throw new Error("Choose the skill's folder.");
  const name = path.basename(from);
  if (!SkillName.safeParse(name).success) throw new Error("A skill's folder is named in lowercase words joined by hyphens, like release-notes. Rename the folder and try again.");
  const root = await realpath(from).catch(() => null);
  const skill = root === null ? null : await stat(path.join(root, "SKILL.md")).catch(() => null);
  if (root === null || !skill?.isFile()) throw new Error("Choose a folder with a SKILL.md in it.");
  const folder = path.join(place, name);
  await mkdir(place, { recursive: true });
  if (await exists(folder)) throw taken(name);
  const staging = path.join(place, `.openorc-import-${randomUUID()}`);
  try {
    await copySkillTree(root, staging);
    if (await exists(folder)) throw taken(name);
    await rename(staging, folder);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return folder;
}

const IMAGE = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]*={0,2})$/;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** How far into an SVG its root element may start, after an XML declaration, comments and a doctype. */
const SVG_PROLOG = 4096;

const utf8 = (bytes: Buffer): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

function isSvg(bytes: Buffer): boolean {
  const text = utf8(bytes) ?? "";
  const start = text.search(/<svg[\s>]/i);
  if (start < 0 || start > SVG_PROLOG) return false;
  return (
    text
      .slice(0, start)
      .replace(/<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "")
      .trim() === ""
  );
}

/** Whether the bytes are what their type says, by the signature each format starts with. */
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (bytes) => bytes.subarray(0, PNG.length).equals(PNG),
  "image/jpeg": (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
  "image/svg+xml": isSvg,
};

/** A data URL's image, checked against what it claims to be. */
export function decodedSkillImage(image: string): { type: string; extension: string; bytes: Buffer } {
  const match = IMAGE.exec(image);
  const type = match?.[1] ?? "";
  const bytes = Buffer.from(match?.[2] ?? "", "base64");
  if (!match || !bytes.length) throw new Error("Choose a PNG, JPEG, WebP or SVG image.");
  if (bytes.length > MAX_SKILL_ICON_BYTES) throw new Error("Choose an image smaller than 512 KB.");
  if (!SIGNATURES[type]?.(bytes)) throw new Error("This image could not be read. Choose another one.");
  return { type, extension: EXTENSIONS[type]!, bytes };
}

/** Writes bytes to `root/file` all at once, refusing a linked or changing folder on the way. */
async function writeBytes(root: string, file: string, bytes: Buffer): Promise<void> {
  const directories = new Map<string, string>();
  const target = path.join(root, file);
  await assertSafeParentPath(root, file, directories);
  await mkdir(path.dirname(target), { recursive: true });
  await assertSafeParentPath(root, file, directories);
  const temporary = path.join(path.dirname(target), `.openorc-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await assertSafeParentPath(root, file, directories);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Points the interface file at `icon`, or at no image, with the same safe save the editor uses. */
async function pointInterfaceAt(files: Pick<FileService, "save">, root: string, icon: string | null): Promise<void> {
  const bytes = await readFile(path.join(root, SKILL_INTERFACE_FILE)).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  const source = bytes === null ? null : bytes.toString("utf8");
  const next = withSkillIcon(source, icon);
  if (next === null || next === source) return;
  const expected = bytes === null ? { kind: "absent" as const } : { kind: "version" as const, version: versionOf(bytes) };
  const outcome = await files.save(root, FolderPath.parse(SKILL_INTERFACE_FILE), next, expected);
  if (outcome.kind === "conflict") throw new Error(`${SKILL_INTERFACE_FILE} changed while the image was saved. Try again.`);
}

/**
 * Sets a skill's image: written to `assets/icon.<ext>` in its folder and named by both sizes in its interface file, an
 * image set before removed. Null takes the image away. Answers the image as a data URL, or null.
 */
export async function setSkillIcon(files: Pick<FileService, "save">, root: string, image: string | null): Promise<string | null> {
  const decoded = image === null ? null : decodedSkillImage(image);
  const icon = decoded ? `assets/icon.${decoded.extension}` : null;
  if (decoded && icon) await writeBytes(root, icon, decoded.bytes);
  await pointInterfaceAt(files, root, icon ? `./${icon}` : null);
  const directories = new Map<string, string>();
  for (const extension of Object.keys(SKILL_ICON_TYPES)) {
    const older = `assets/icon.${extension}`;
    if (older === icon) continue;
    await assertSafeParentPath(root, older, directories);
    await rm(path.join(root, older), { force: true });
  }
  return decoded ? `data:${decoded.type};base64,${decoded.bytes.toString("base64")}` : null;
}

/**
 * What moving a skill to the Trash moves: its folder, or its file for a one-file skill. A Claude account added in
 * OpenOrc lists the CLI login's personal skills through links OpenOrc made, which it makes again while the skill is
 * installed, so for those the skill itself goes.
 */
export async function removalTarget(agent: HarnessId, skill: Pick<AgentSkill, "path">, env: NodeJS.ProcessEnv): Promise<string> {
  const entry = skillFolderOf(skill.path) ?? skill.path;
  const shared = agent === "claude" ? env[SHARED_CLAUDE_CONFIG_DIR] : undefined;
  if (!shared) return entry;
  const link = await readlink(entry).catch(() => null);
  return link !== null && path.dirname(link) === path.join(shared, "skills") ? link : entry;
}

/** Whether a skill's folder holds other skills, which moving it would take with it. */
export const holdsOtherSkills = (files: SkillFile[]): boolean => files.some((file) => file.kind === "file" && /\/skill\.md$/i.test(file.path));

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { harnessIds, type HarnessId } from "@openorc/protocol";

/*
 * Kept from the person's own cloud, which is gone, for a person's skills to reach OpenOrc Cloud in (see
 * .local-development/multiplayer/ui/cloud-parity/build/from-own-cloud.md): the bundle's format, the reader of skill
 * folders, the digest, and the store that keeps a payload on disk. Nothing in the app calls it today.
 */

/** One file of a skill, by its path inside the skill's folder. */
export interface SkillFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface SkillCopy {
  name: string;
  files: SkillFile[];
}

/** The skills an agent gets, named by what they hold; `skipped` names files left out for their size. */
export interface SkillBundle {
  digest: string;
  skills: SkillCopy[];
  skipped: string[];
}

/** Where an agent's skills come from: a person's chosen ones, or a copy kept on disk. */
export interface SkillSource {
  bundle(agent: HarnessId): Promise<SkillBundle>;
}

/** A skill's folder name, as agents load it and as a path may hold it. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Larger files, such as a skill's images or archives, are left out. */
const FILE_BYTES = 1024 * 1024;
/** The most one agent's skills take in all; a skill past it is left out whole. */
const AGENT_BYTES = 16 * 1024 * 1024;
const SKILL_FILES = 500;
/** Folders a skill never needs elsewhere. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules", "__pycache__", ".venv"]);

/** Names what the skills hold, the same whichever side reads them, so a copy that matches is never sent again. */
export function digestOf(skills: SkillCopy[]): string {
  const hash = createHash("sha256");
  for (const skill of [...skills].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    hash.update(`skill ${skill.name}\n`);
    for (const file of [...skill.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      hash.update(`${file.executable ? "x" : "-"} ${file.path} ${createHash("sha256").update(file.content).digest("hex")}\n`);
    }
  }
  return hash.digest("hex");
}

/** Every file in a skill's folder that goes with it, a symlink to a file read through; `skipped` too large to. */
async function skillFiles(folder: string): Promise<{ files: SkillFile[]; skipped: string[] }> {
  const files: SkillFile[] = [];
  const skipped: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(path.join(folder, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name === ".DS_Store" || files.length >= SKILL_FILES) continue;
      const info = await stat(path.join(folder, rel)).catch(() => null);
      if (!info) continue;
      // A folder reached through a symlink could loop or leave the skill; only the skill's own folders are walked.
      if (info.isDirectory() && !entry.isSymbolicLink() && !SKIPPED_FOLDERS.has(entry.name)) await walk(rel);
      if (!info.isFile()) continue;
      if (info.size > FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      files.push({ path: rel, content: await readFile(path.join(folder, rel)), executable: (info.mode & 0o111) !== 0 });
    }
  };
  await walk("");
  return { files, skipped };
}

/** The skills in `folders`, read whole, within the size one agent takes; one too large is skipped whole. */
export async function readSkills(folders: { name: string; folder: string }[]): Promise<SkillBundle> {
  const skills: SkillCopy[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const { name, folder } of folders) {
    if (!SKILL_NAME.test(name)) continue;
    const real = await realpath(folder).catch(() => null);
    if (!real) continue;
    const read = await skillFiles(real).catch(() => null);
    if (!read?.files.length) continue;
    skipped.push(...read.skipped.map((file) => `${name}/${file}`));
    const size = read.files.reduce((sum, file) => sum + file.content.length, 0);
    if (bytes + size > AGENT_BYTES) {
      skipped.push(name);
      continue;
    }
    bytes += size;
    skills.push({ name, files: read.files });
  }
  return { digest: digestOf(skills), skills, skipped };
}

/** The skills `storeSkills` keeps in `dir`, by agent. */
export class StoredSkills implements SkillSource {
  constructor(private readonly dir: string) {}

  async bundle(agent: HarnessId): Promise<SkillBundle> {
    const folder = path.join(this.dir, agent);
    const names = await readdir(folder).catch(() => []);
    return readSkills(names.sort().map((name) => ({ name, folder: path.join(folder, name) })));
  }
}

/** Every agent's skills in one file, as they travel. */
export interface SkillsPayload {
  v: 1;
  agents: Record<HarnessId, { name: string; files: { path: string; data: string; executable: boolean }[] }[]>;
}

/** The payload of a source's skills, the digest naming it, and how many skills it holds. */
export async function skillsPayload(source: SkillSource): Promise<{ digest: string; bytes: Buffer; count: number }> {
  const bundles = await Promise.all(harnessIds.map(async (agent) => [agent, await source.bundle(agent)] as const));
  const digest = createHash("sha256")
    .update(bundles.map(([agent, bundle]) => `${agent} ${bundle.digest}`).join("\n"))
    .digest("hex");
  const agents = Object.fromEntries(
    bundles.map(([agent, bundle]) => [
      agent,
      bundle.skills.map((skill) => ({ name: skill.name, files: skill.files.map((file) => ({ path: file.path, data: file.content.toString("base64"), executable: file.executable })) })),
    ]),
  ) as SkillsPayload["agents"];
  const payload: SkillsPayload = { v: 1, agents };
  const count = bundles.reduce((sum, [, bundle]) => sum + bundle.skills.length, 0);
  return { digest, bytes: Buffer.from(JSON.stringify(payload)), count };
}

const NOT_SKILLS = "These skills are not in a form OpenOrc reads.";

/** A payload checked for its shape; names and paths are checked as they are stored. */
export function parseSkillsPayload(text: string): SkillsPayload {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) throw new Error(NOT_SKILLS);
  const agents = (value as { agents?: unknown }).agents;
  if (!agents || typeof agents !== "object") throw new Error(NOT_SKILLS);
  const isFile = (file: unknown) => {
    const { path: at, data, executable } = (file ?? {}) as Record<string, unknown>;
    return typeof at === "string" && typeof data === "string" && typeof executable === "boolean";
  };
  const isSkill = (skill: unknown) => {
    const { name, files } = (skill ?? {}) as Record<string, unknown>;
    return typeof name === "string" && Array.isArray(files) && files.every(isFile);
  };
  const parsed = {} as SkillsPayload["agents"];
  for (const agent of harnessIds) {
    const skills = (agents as Record<string, unknown>)[agent] ?? [];
    if (!Array.isArray(skills) || !skills.every(isSkill)) throw new Error(NOT_SKILLS);
    parsed[agent] = skills as SkillsPayload["agents"][HarnessId];
  }
  return { v: 1, agents: parsed };
}

/** A path inside a skill's folder, never leaving it. */
const safeFile = (file: string) => !file.startsWith("/") && !file.split("/").some((part) => part === ".." || part === "" || part === ".");

/** Replaces the skills in `dir` with the ones in `payload`, all at once. Returns how many it holds. */
export async function storeSkills(dir: string, payload: SkillsPayload): Promise<number> {
  const next = `${dir}.next`;
  await rm(next, { recursive: true, force: true });
  let count = 0;
  for (const agent of harnessIds) {
    for (const skill of payload.agents[agent] ?? []) {
      if (!SKILL_NAME.test(skill.name)) throw new Error(`A skill named ${skill.name} cannot be kept.`);
      for (const file of skill.files) {
        if (!safeFile(file.path)) throw new Error(`The skill ${skill.name} names a file outside its folder.`);
        const target = path.join(next, agent, skill.name, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.data, "base64"), { mode: file.executable ? 0o755 : 0o644 });
      }
      count += 1;
    }
  }
  await mkdir(next, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rename(next, dir);
  return count;
}

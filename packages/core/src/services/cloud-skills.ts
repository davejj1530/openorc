import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listSkills } from "@openorc/agents";
import type { Sandbox } from "@openorc/cloud";
import { settings, type Db } from "@openorc/db";
import { harnessCatalog, harnessIds, type AgentSkill, type CloudSkills as CloudSkillsView, type HarnessId } from "@openorc/protocol";

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

/** The skills an agent gets in its sandbox, named by what they hold; `skipped` names files left out for their size. */
export interface SkillBundle {
  digest: string;
  skills: SkillCopy[];
  skipped: string[];
}

/** Where a cloud turn's agent gets the user's skills from: this Mac's chosen ones, or on a brain the copy its Mac sent. */
export interface CloudSkillSource {
  bundle(agent: HarnessId): Promise<SkillBundle>;
}

const SETTING = "cloud.skills";
/** A skill's folder name, as agents load it and as a sandbox's path may hold it. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Larger files, such as a skill's images or archives, stay on this Mac. */
const FILE_BYTES = 1024 * 1024;
/** The most one agent's skills take in all; a skill past it is left out whole. */
const AGENT_BYTES = 16 * 1024 * 1024;
const SKILL_FILES = 500;
/** How long a listing of an agent's skills stands for a bundle: listing may start the agent's CLI. */
const LISTED_MS = 60_000;
/** Folders a skill never needs in the cloud. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules", "__pycache__", ".venv"]);
/** What a sandbox's agent folder records of the skills OpenOrc put there. */
const MARKER = ".openorc-skills.json";

const EMPTY: SkillBundle = { digest: digestOf([]), skills: [], skipped: [] };

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

/** The skills in `folders`, read whole, within the size an agent's sandbox takes; one too large is skipped whole. */
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

type Chosen = Record<HarnessId, string[]>;

/**
 * On a Mac: the user's own skills, each agent's, and which of them go to cloud sessions, as chosen in Settings. A
 * project's skills come with its files, and plugin and built-in skills stay here.
 */
export class CloudSkills implements CloudSkillSource {
  private readonly listed = new Map<HarnessId, { at: number; skills: Promise<AgentSkill[]> }>();

  constructor(
    private readonly deps: {
      db: Db;
      /** A folder to ask each agent about, holding no project skills of its own. */
      root: string;
      /** The environment Claude Code's skills are found in, its default account's. */
      claudeEnv?: () => NodeJS.ProcessEnv;
      list?: typeof listSkills;
      changed?: () => void;
    },
  ) {}

  chosen(): Chosen {
    const raw = settings.get(this.deps.db, SETTING);
    const parsed = raw ? (JSON.parse(raw) as Partial<Chosen>) : {};
    return Object.fromEntries(harnessIds.map((agent) => [agent, parsed[agent] ?? []])) as Chosen;
  }

  /** The agent's own skills, listed again when `fresh` or the last listing is a minute old. */
  private own(agent: HarnessId, fresh: boolean): Promise<AgentSkill[]> {
    const last = this.listed.get(agent);
    if (!fresh && last && Date.now() - last.at < LISTED_MS) return last.skills;
    const list = this.deps.list ?? listSkills;
    const env = agent === "claude" && this.deps.claudeEnv ? { env: this.deps.claudeEnv() } : {};
    const skills = list({ projectRoot: this.deps.root, agent, ...env }).then((all) => all.filter((skill) => skill.source === "user" && skill.enabled !== false));
    this.listed.set(agent, { at: Date.now(), skills });
    skills.catch(() => this.listed.delete(agent));
    return skills;
  }

  /** Each agent's own skills and whether each goes; an agent that could not list them says why. */
  async catalog(): Promise<CloudSkillsView> {
    const chosen = this.chosen();
    const agents = await Promise.all(
      harnessIds
        .filter((agent) => harnessCatalog[agent].cloud)
        .map(async (agent) => {
          try {
            const skills = (await this.own(agent, true)).map(({ name, description }) => ({ name, description, chosen: chosen[agent].includes(name) }));
            return { agent, skills, error: null };
          } catch (error) {
            return { agent, skills: [], error: error instanceof Error ? error.message : String(error) };
          }
        }),
    );
    return { agents };
  }

  async choose(agent: HarnessId, name: string, on: boolean): Promise<CloudSkillsView> {
    if (!harnessCatalog[agent].cloud) throw new Error(`${harnessCatalog[agent].name} does not run in cloud workspaces yet.`);
    const chosen = this.chosen();
    const rest = chosen[agent].filter((each) => each !== name);
    settings.set(this.deps.db, SETTING, JSON.stringify({ ...chosen, [agent]: on ? [...rest, name].sort() : rest }));
    this.deps.changed?.();
    return this.catalog();
  }

  /** The chosen skills of `agent` that it still has here. */
  async bundle(agent: HarnessId): Promise<SkillBundle> {
    if (!harnessCatalog[agent].cloud) return EMPTY;
    const chosen = this.chosen()[agent];
    if (!chosen.length) return EMPTY;
    const own = await this.own(agent, false).catch(() => []);
    return readSkills(own.filter((skill) => chosen.includes(skill.name)).map((skill) => ({ name: skill.name, folder: path.dirname(skill.path) })));
  }
}

/** On a cloud brain: the skills its Mac sent, kept in `dir` by agent, every one of them going. */
export class StoredCloudSkills implements CloudSkillSource {
  constructor(private readonly dir: string) {}

  async bundle(agent: HarnessId): Promise<SkillBundle> {
    const folder = path.join(this.dir, agent);
    const names = await readdir(folder).catch(() => []);
    return readSkills(names.sort().map((name) => ({ name, folder: path.join(folder, name) })));
  }
}

/** Every agent's skills in one file, as a Mac sends them to its brain. */
export interface SkillsPayload {
  v: 1;
  agents: Record<HarnessId, { name: string; files: { path: string; data: string; executable: boolean }[] }[]>;
}

/** What a Mac sends its brain, the digest naming it, and how many skills it holds. */
export async function skillsPayload(source: CloudSkillSource): Promise<{ digest: string; bytes: Buffer; count: number }> {
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

const NOT_SKILLS = "The skills the Mac sent are not in a form this brain reads.";

/** The skills a Mac sent, checked for their shape; names and paths are checked as they are stored. */
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

/** On a cloud brain: replaces the skills in `dir` with the ones in `payload`, all at once. Returns how many it holds. */
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

/**
 * Puts `bundle` in a sandbox's skills folder `target`, as the agent there finds its user's skills: the skills OpenOrc
 * put there before and no longer sends are taken away, and each it sends replaces its folder whole. A folder that
 * already holds this digest is left alone.
 */
export async function placeSkills(sandbox: Sandbox, target: string, bundle: SkillBundle): Promise<void> {
  const marker = path.posix.join(target, MARKER);
  const before = await sandbox.readFile(marker).catch(() => null);
  let placed: { digest?: string; names?: string[] } = {};
  try {
    placed = before ? (JSON.parse(before.toString("utf8")) as typeof placed) : {};
  } catch {
    placed = {};
  }
  if (placed.digest === bundle.digest || (!before && !bundle.skills.length)) return;
  const names = bundle.skills.map((skill) => skill.name);
  const gone = [...new Set([...(placed.names ?? []).filter((name) => SKILL_NAME.test(name)), ...names])];
  if (gone.length) await sandbox.exec("sh", ["-c", 'cd -- "$1" 2>/dev/null || exit 0; shift; rm -rf -- "$@"', "sh", target, ...gone]);
  const executable: string[] = [];
  for (const skill of bundle.skills) {
    for (const file of skill.files) {
      const at = path.posix.join(target, skill.name, file.path);
      await sandbox.writeFile(at, file.content);
      if (file.executable) executable.push(at);
    }
  }
  if (executable.length) await sandbox.exec("chmod", ["+x", "--", ...executable]);
  await sandbox.writeFile(marker, Buffer.from(JSON.stringify({ digest: bundle.digest, names })));
}

/** Where each agent finds its user's skills, in a shell given its turn's folders. */
const SKILLS_DIR: Record<HarnessId, string> = {
  cursor: '"$HOME/.cursor/skills"',
  pi: '"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills"',
  antigravity: '"$HOME/.gemini/config/skills"',
  fx: '"${FX_HOME:-$HOME/.fx}/skills"',
  claude: '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"',
  codex: '"${CODEX_HOME:-$HOME/.codex}/skills"',
  opencode: '"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"',
  omp: '"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills"',
};

/** The folder the agent in a sandbox finds its user's skills in, with `env` its turn's folders. */
export async function sandboxSkillsDir(sandbox: Sandbox, agent: HarnessId, env: Record<string, string>): Promise<string> {
  const result = await sandbox.exec("sh", ["-c", `printf %s ${SKILLS_DIR[agent]}`], { env });
  const dir = result.stdout.toString("utf8").trim();
  if (result.code !== 0 || !dir.startsWith("/")) throw new Error(`The sandbox did not say where ${agent}'s skills go.`);
  return dir;
}

/**
 * Puts the user's chosen skills where each agent in a sandbox finds them before its turn, asking the sandbox only when
 * they changed since. A failure is told to `warn`, and the turn runs without them.
 */
export class SandboxSkills {
  private readonly placed = new WeakMap<Sandbox, Map<string, string>>();

  constructor(
    private readonly source: CloudSkillSource | undefined,
    private readonly warn: (message: string) => void,
  ) {}

  /** `folders` are the agent's folders in the sandbox, as its turn's sign-in names them. */
  async place(sandbox: Sandbox, agent: HarnessId, folders: Record<string, string>): Promise<void> {
    if (!this.source) return;
    try {
      const bundle = await this.source.bundle(agent);
      const key = `${agent} ${JSON.stringify(folders)}`;
      const seen = this.placed.get(sandbox) ?? new Map<string, string>();
      if (seen.get(key) === bundle.digest) return;
      await placeSkills(sandbox, await sandboxSkillsDir(sandbox, agent, folders), bundle);
      seen.set(key, bundle.digest);
      this.placed.set(sandbox, seen);
    } catch (error) {
      this.warn(`${agent}'s skills did not reach its sandbox, so this turn runs without them: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

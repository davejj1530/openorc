/**
 * The person's own skills on this Mac, as their turns on OpenOrc Cloud get them (@openorc/hosted `OwnSkills`): each
 * agent's own, the ones that are on, by the folder the agent finds each in. A project's skills travel with its code,
 * and a plugin's or the agent's built-ins stay where they are.
 *
 * A skill is named by the SHA-256 of its pack, and a pack is read from the disk as it is sent, never held whole. A
 * skill whose files are as they were (their paths, sizes, times and whether they run) keeps the digest it had, so an
 * unchanged skill is not read again. Nothing is left out for its size.
 */
import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listSkills } from "@openorc/agents";
import type { OwnSkill } from "@openorc/hosted";
import type { AgentSkill, HarnessId } from "@openorc/protocol";

/** How long an agent's listing of its skills stands: listing may start the agent's CLI. */
const LISTED_MS = 60_000;
/** What a skill never needs in the cloud: this Mac's own marks, and folders its tools fill. */
const LEFT_OUT = new Set([".DS_Store", ".git", "node_modules", "__pycache__", ".venv"]);
const CHUNK_BYTES = 256 * 1024;

/** One file of a skill as it stood when it was listed. */
type SkillFile = { rel: string; at: string; bytes: number; modified: number; runs: boolean };

/**
 * A skill this Mac could not read, with the file in it that could not be, by its place in the skill, or none for the
 * skill's folder itself. Its words name the two ways on that the app already has.
 */
class SkillUnreadable extends Error {
  constructor(name: string, rel: string | null) {
    super(
      rel
        ? `Your skill ${name} couldn't be read on this Mac (${rel}). Fix that file, or turn the skill off in Settings > Skills, then send again.`
        : `Your skill ${name} couldn't be read on this Mac. Fix its folder, or turn the skill off in Settings > Skills, then send again.`,
    );
  }
}

const changed = (name: string) => new Error(`The skill ${name} changed while it was being sent. Send again.`);

/** Every file of the skill `name` in `folder`, links read through, in the order of their paths. A folder met twice is walked once. */
async function filesOf(name: string, folder: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const walked = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    const real = await realpath(path.join(folder, dir)).catch(() => {
      throw new SkillUnreadable(name, dir || null);
    });
    if (walked.has(real)) return;
    walked.add(real);
    const entries = await readdir(real).catch(() => {
      throw new SkillUnreadable(name, dir || null);
    });
    for (const entry of entries) {
      if (LEFT_OUT.has(entry)) continue;
      const rel = dir ? `${dir}/${entry}` : entry;
      const at = path.join(real, entry);
      const info = await stat(at).catch(() => {
        throw new SkillUnreadable(name, rel);
      });
      if (info.isDirectory()) await walk(rel);
      else if (info.isFile()) files.push({ rel, at, bytes: info.size, modified: info.mtimeMs, runs: (info.mode & 0o111) !== 0 });
    }
  };
  await walk("");
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

const header = (name: string, file: SkillFile) => Buffer.from(`${name}/${file.rel}\0${file.runs ? "x" : "-"}\0${file.bytes}\0`);

/** One file's bytes, exactly as many as it had when listed: a file that is now shorter, longer or gone has changed. */
async function* bytesOf(name: string, file: SkillFile): AsyncGenerator<Uint8Array> {
  const handle = await open(file.at, "r").catch(() => {
    throw changed(name);
  });
  try {
    if ((await handle.stat()).size !== file.bytes) throw changed(name);
    for (let sent = 0; sent < file.bytes;) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, file.bytes - sent));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, sent);
      if (bytesRead !== chunk.length) throw changed(name);
      sent += bytesRead;
      yield chunk;
    }
  } finally {
    await handle.close();
  }
}

/** A skill's pack: each file as `<name>/<path>\0<mode>\0<length>\0<bytes>`, as the server reads it. */
async function* packOf(name: string, files: readonly SkillFile[]): AsyncGenerator<Uint8Array> {
  for (const file of files) {
    yield header(name, file);
    yield* bytesOf(name, file);
  }
}

/** What says a skill's files are as they were, without opening one. */
const standing = (files: readonly SkillFile[]) => files.map((file) => `${file.rel}\0${file.bytes}\0${file.modified}\0${file.runs ? "x" : "-"}`).join("\n");

export class HostedSkills {
  private readonly listed = new Map<HarnessId, { at: number; skills: AgentSkill[] }>();
  private readonly listing = new Map<HarnessId, Promise<AgentSkill[]>>();
  /** Each skill's digest by its folder, with what its files stood as when it was taken. */
  private readonly digests = new Map<string, { standing: string; digest: string }>();

  constructor(
    private readonly deps: {
      /** A folder to ask each agent about, holding no project skills of its own. */
      root: string;
      /** The environment Claude Code's skills are found in, its default account's. */
      claudeEnv?: () => NodeJS.ProcessEnv;
      list?: typeof listSkills;
      now?: () => number;
    },
  ) {}

  /**
   * The agent's own skills that are on. Rejects in words when the agent cannot list them or one cannot be read; after
   * one could not be, the agent is asked again at the next call, so a skill turned off in Settings is left out then.
   */
  async own(agent: HarnessId): Promise<OwnSkill[]> {
    const own: OwnSkill[] = [];
    const taken = new Set<string>();
    try {
      for (const skill of await this.list(agent)) {
        const folder = path.dirname(skill.path);
        const name = path.basename(folder);
        // The agent finds one skill under a name; its first is the one it runs.
        if (!skill.path || name.startsWith(".") || taken.has(name)) continue;
        taken.add(name);
        const files = await filesOf(name, folder);
        own.push({ name, digest: await this.digest(folder, name, files), pack: () => packOf(name, files) });
      }
    } catch (error) {
      if (error instanceof SkillUnreadable) this.listed.delete(agent);
      throw error;
    }
    return own;
  }

  private async digest(folder: string, name: string, files: readonly SkillFile[]): Promise<string> {
    const now = standing(files);
    const key = `${name}\0${folder}`;
    const held = this.digests.get(key);
    if (held?.standing === now) return held.digest;
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(header(name, file));
      try {
        for await (const chunk of bytesOf(name, file)) hash.update(chunk);
      } catch {
        throw new SkillUnreadable(name, file.rel);
      }
    }
    const digest = hash.digest("hex");
    this.digests.set(key, { standing: now, digest });
    return digest;
  }

  /**
   * The agent's own skills as it lists them. A listing stands a minute; past that the last one still answers at once
   * while the agent is asked again, so a send never waits on a CLI that was asked before.
   */
  private async list(agent: HarnessId): Promise<AgentSkill[]> {
    const last = this.listed.get(agent);
    const now = this.deps.now?.() ?? Date.now();
    if (!last) return this.ask(agent);
    if (now - last.at >= LISTED_MS) this.ask(agent).catch(() => undefined);
    return last.skills;
  }

  private ask(agent: HarnessId): Promise<AgentSkill[]> {
    const asking = this.listing.get(agent);
    if (asking) return asking;
    const list = this.deps.list ?? listSkills;
    const env = agent === "claude" && this.deps.claudeEnv ? { env: this.deps.claudeEnv() } : {};
    const asked = list({ projectRoot: this.deps.root, agent, ...env })
      .then((all) => {
        const skills = all.filter((skill) => skill.source === "user" && skill.enabled !== false);
        this.listed.set(agent, { at: this.deps.now?.() ?? Date.now(), skills });
        return skills;
      })
      .finally(() => this.listing.delete(agent));
    this.listing.set(agent, asked);
    return asked;
  }
}

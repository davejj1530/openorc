import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLOUD_ENV_LIMITS, type CloudEnvFile } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** Each project's variables, by the id of the project on the Mac that set them. */
type Stored = Record<string, Record<string, string>>;

const UNREADABLE = "Cannot access protected storage for the projects' cloud environments. Unlock your OS keychain or secret service and retry.";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The most a project's variables may take in all, which each of its cloud turns carries. */
const PROJECT_BYTES = 64 * 1024;
/** The most every project's variables may take together, as the cloud brain's sealed handover carries them. */
const TOTAL_BYTES = 256 * 1024;

/** What the sandbox and OpenOrc set for every turn: a project's own would break the turn or its agent's folders. */
const RESERVED = new Set([
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TMPDIR",
  "LANG",
  "NODE_OPTIONS",
  "NODE_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
]);
/**
 * Names that choose an agent's own sign-in: one from a project would switch the agent off its subscription, onto an
 * API key billed by the token, or sign it in somewhere else.
 */
const SIGN_IN_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "OPENCODE_", "OPENORC_"];

/** Why a name cannot be one of a project's cloud variables, or null when it can. */
export function cloudEnvNameProblem(name: string): string | null {
  if (!NAME.test(name)) return `${name || "A name"} is not a variable name: letters, digits and _, not starting with a digit.`;
  if (RESERVED.has(name)) return `${name} is set by the sandbox for every turn.`;
  const prefix = SIGN_IN_PREFIXES.find((start) => name.startsWith(start));
  return prefix ? `${name} can't be set here: ${prefix}… names choose the agent's own sign-in.` : null;
}

/**
 * The variables in a .env file: KEY=value lines, `export` allowed, quotes taken off, \n in double quotes a line break,
 * a # after unquoted space a comment. Lines that set no valid variable are left out.
 */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const found = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rest] = match as unknown as [string, string, string];
    found.set(name, dotEnvValue(rest));
  }
  return [...found].map(([name, value]) => ({ name, value }));
}

function dotEnvValue(rest: string): string {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    const inner = end === -1 ? rest.slice(1) : rest.slice(1, end);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  return rest.replace(/\s+#.*$/, "").trim();
}

/** The projects' environments as a cloud brain is handed them, in one order, so a print of them is the same on either side. */
export function handedEnv(all: { source: string; vars: Record<string, string> }[]): { source: string; vars: { name: string; value: string }[] }[] {
  return all
    .filter(({ vars }) => Object.keys(vars).length)
    .sort((a, b) => (a.source < b.source ? -1 : 1))
    .map(({ source, vars }) => ({
      source,
      vars: Object.keys(vars)
        .sort()
        .map((name) => ({ name, value: vars[name]! })),
    }));
}

/** The .env files a project's cloud environment is filled from, in the order their values win. */
const ENV_FILES = [".env", ".env.local"];

/** What the project's .env files hold, the later file winning a name both set. Reads only. */
export async function projectDotEnv(rootPath: string): Promise<CloudEnvFile> {
  const files: string[] = [];
  const found = new Map<string, string>();
  for (const file of ENV_FILES) {
    const text = await readFile(path.join(rootPath, file), "utf8").catch(() => null);
    if (text === null) continue;
    files.push(file);
    for (const { name, value } of parseDotEnv(text)) found.set(name, value);
  }
  return { files, entries: [...found].map(([name, value]) => ({ name, value })) };
}

/**
 * Each project's cloud environment, in protected storage: variables its cloud turns and setup script get, set in
 * Settings and never read back there. On a cloud brain, exactly what its Mac handed over, by the Mac's project ids.
 */
export class CloudProjectEnv {
  private cache: Stored | undefined;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly changed: () => void = () => undefined,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Stored> {
    if (this.cache) return this.cache;
    if (!this.store) return (this.cache = {});
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(UNREADABLE);
    }
    this.cache = raw ? (JSON.parse(raw) as Stored) : {};
    return this.cache;
  }

  private async write(next: Stored): Promise<void> {
    if (!this.store) throw new Error("This build keeps no cloud environments.");
    await this.store.save(JSON.stringify(next));
    this.cache = next;
    this.changed();
  }

  /** The project's variable names, never their values. */
  async names(projectId: string): Promise<string[]> {
    return Object.keys((await this.read())[projectId] ?? {}).sort();
  }

  /** The project's variables, for its cloud turns. */
  async vars(projectId: string): Promise<Record<string, string>> {
    return { ...((await this.read())[projectId] ?? {}) };
  }

  /**
   * Replaces the project's variables with `entries`. One with no value keeps the value saved under its name; a name
   * left out is removed. Refuses, changing nothing, a name that cannot be set or a value too large.
   */
  set(projectId: string, entries: { name: string; value?: string | undefined }[]): Promise<string[]> {
    return this.serialize(async () => {
      const stored = await this.read();
      const before = stored[projectId] ?? {};
      const next: Record<string, string> = {};
      for (const { name, value } of entries) {
        const problem = cloudEnvNameProblem(name);
        if (problem) throw new Error(problem);
        if (name in next) throw new Error(`${name} is set twice.`);
        const kept = value ?? before[name];
        if (kept === undefined) throw new Error(`Enter a value for ${name}.`);
        next[name] = kept;
      }
      if (Object.keys(next).length > CLOUD_ENV_LIMITS.entries) throw new Error(`A project's cloud environment holds at most ${CLOUD_ENV_LIMITS.entries} variables.`);
      if (Buffer.byteLength(JSON.stringify(next)) > PROJECT_BYTES) throw new Error("These variables are too large for a cloud turn to carry. Keep large files in the project instead.");
      const { [projectId]: _old, ...rest } = stored;
      const all = Object.keys(next).length ? { ...rest, [projectId]: next } : rest;
      const handed = handedEnv(Object.entries(all).map(([source, vars]) => ({ source, vars })));
      if (Buffer.byteLength(JSON.stringify({ projects: handed })) > TOTAL_BYTES)
        throw new Error("Your projects' cloud variables together are too large to hand to the cloud brain. Remove some from another project.");
      await this.write(all);
      return Object.keys(next).sort();
    });
  }

  /** Every project's variables, for a cloud brain's sealed handover. */
  async all(): Promise<{ source: string; vars: Record<string, string> }[]> {
    return Object.entries(await this.read())
      .map(([source, vars]) => ({ source, vars }))
      .sort((a, b) => (a.source < b.source ? -1 : 1));
  }

  /** On a cloud brain: exactly the variables its Mac handed over, replacing any before. */
  adopt(projects: { source: string; vars: Record<string, string> }[]): Promise<void> {
    return this.serialize(() => this.write(Object.fromEntries(projects.map(({ source, vars }) => [source, vars]))));
  }
}

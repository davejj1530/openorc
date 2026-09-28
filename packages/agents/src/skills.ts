/**
 * Skills on disk for Claude Code and OpenCode.
 *
 * Discovery only. Claude Code resolves "/name" out of the prompt itself once
 * the text reaches the CLI, so nothing here runs a skill or reads its body:
 * we find the headers, the composer writes "/name " at the caret, and the
 * provider does the rest.
 */
import { open, readFile, readdir, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSkill } from "@openorc/protocol";
import type { HarnessId } from "@openorc/protocol";
import { parse } from "jsonc-parser";
import { claudeConfigDir } from "./claude/config-dir.js";
import { listCodexSkills } from "./codex/skills.js";
import { listNativeOpenCodeSkills, openCodeSkillRows } from "./opencode/skills.js";

/** A directory of skills, and what the CLI would call the ones inside it. */
interface SkillRoot {
  dir: string;
  source: AgentSkill["source"];
  /** Plugin tier only: the CLI resolves those as "/<plugin>:<skill>", so the prefix is part of the name. */
  plugin?: string;
}

/**
 * A skills directory is hand-curated, and the largest real ones hold a few
 * dozen entries. 200 keeps an order of magnitude of headroom while still
 * bounding what a junk directory under `skills/` can cost us. It counts
 * skills we accepted, not names we looked at, so junk cannot evict a real one.
 */
export const MAX_ENTRIES = 200;

/**
 * Frontmatter is the first block of the file, and the longest real headers,
 * the ones whose description lists every trigger phrase, run under 2 KB. 8 KiB
 * reads all of them, and a huge or binary SKILL.md still costs one bounded
 * read instead of its whole length.
 */
export const MAX_SKILL_BYTES = 8 * 1024;

/** Only a delimiter in the first column ends the header; an indented one is somebody's value. */
const DELIMITER = /^(---|\.\.\.)[ \t]*$/;

/** A block scalar opener: `|`, `>`, and the indent and chomping indicators YAML allows after them. */
const BLOCK = /^([|>])[0-9+-]*$/;

/** A flat `key: value` at the top level of the header. Anything indented belongs to the key above it. */
const FIELD = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/;

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * The `name` and `description` out of a SKILL.md header.
 *
 * Deliberately not a YAML parser, and not a dependency either: the header is a
 * flat map written by hand, the two keys we want are plain strings, and the
 * caller already tolerates an absent value, so anything this does not
 * understand can fall through instead of being modelled. Comments are left in
 * a plain scalar rather than stripped, because a `#` inside a description is
 * likelier than a trailing comment in a two-key header.
 */
export function skillHeader(text: string): { name: string | null; description: string | null } {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };
  const fields = new Map<string, string>();
  let i = 1;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (DELIMITER.test(line)) break;
    i += 1;
    const field = FIELD.exec(line);
    if (!field) continue;
    const key = field[1] ?? "";
    // Trimmed before the branch tests, so extra spacing after the colon cannot hide a quote or a block opener.
    const rest = (field[2] ?? "").trim();
    const block = BLOCK.exec(rest);
    if (block) {
      const more = continued(lines, i, true);
      i = more.next;
      // `|` keeps the breaks the author wrote; `>` folds them, a blank line staying a break.
      fields.set(key, block[1] === "|" ? more.lines.join("\n").trim() : fold(more.lines));
      continue;
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      let raw = rest;
      let next = i;
      // A quoted scalar may wrap; YAML folds each break into a space.
      while (closingQuote(raw) === -1 && next < lines.length) {
        const wrapped = lines[next] ?? "";
        // The header's own delimiter is never inside a value, however open the quote still looks.
        if (wrapped.trim() === "" || DELIMITER.test(wrapped)) break;
        raw = `${raw} ${wrapped.trim()}`;
        next += 1;
      }
      const end = closingQuote(raw);
      // A quote that never closes is a typo, not a multi-line value: keep the line it opened on
      // and let the rest of the header parse, rather than swallowing the file body as the value.
      if (end === -1) fields.set(key, unquote(rest));
      else {
        fields.set(key, unquote(raw.slice(0, end)));
        i = next;
      }
      continue;
    }
    // A plain scalar, which may be empty here and continue on the lines below it.
    const more = continued(lines, i, false);
    i = more.next;
    fields.set(
      key,
      [rest, ...more.lines]
        .filter((part) => part !== "")
        .join(" ")
        .trim(),
    );
  }
  return { name: fields.get("name") ?? null, description: fields.get("description") ?? null };
}

/** The indented lines that belong to the value started above them. Blank lines end a plain scalar but sit inside a block. */
function continued(lines: string[], from: number, keepBlanks: boolean): { lines: string[]; next: number } {
  const out: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      if (!keepBlanks) break;
      out.push("");
      i += 1;
      continue;
    }
    if (!/^[ \t]/.test(line)) break;
    out.push(line.trim());
    i += 1;
  }
  while (out[out.length - 1] === "") out.pop();
  return { lines: out, next: i };
}

/** YAML's folded scalar: a line break becomes a space, a blank line stays a break. */
function fold(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (line === "") out += "\n";
    else out += out === "" || out.endsWith("\n") ? line : ` ${line}`;
  }
  return out.trim();
}

/** Index just past the closing quote, or -1 when the scalar is still open at the end of `text`. */
function closingQuote(text: string): number {
  const quote = text[0];
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"' && c === "\\") {
      i += 1;
      continue;
    }
    if (c !== quote) continue;
    // Inside single quotes a doubled quote is one literal quote, not the end.
    if (quote === "'" && text[i + 1] === "'") {
      i += 1;
      continue;
    }
    return i + 1;
  }
  return -1;
}

/** A quoted scalar's text, with YAML's two escape conventions. An unterminated one is kept as far as it was read. */
function unquote(raw: string): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return raw;
  const inner = raw.length > 1 && raw.endsWith(quote) ? raw.slice(1, -1) : raw.slice(1);
  return quote === '"' ? inner.replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c) : inner.replace(/''/g, "'");
}

/** One line for a suggestion row: every run of whitespace, including the breaks a block scalar kept, becomes a space. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The head of a file, at most `MAX_SKILL_BYTES`, or null when it cannot be read at all. */
async function head(file: string): Promise<string | null> {
  try {
    // open() on a FIFO parks until a writer shows up, and one of those under skills/ would
    // hang the whole listing and the RPC behind it, so nothing but a regular file is opened.
    if (!(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SKILL_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // The cut line may be half a key or half a UTF-8 sequence, so drop it rather than parse it.
    return bytesRead === MAX_SKILL_BYTES ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readSkillDir(root: SkillRoot): Promise<AgentSkill[]> {
  let names: string[];
  try {
    // Only a directory can hold a SKILL.md, and dropping the rest up front keeps loose files
    // from spending the cap. A symlink stays in, because it may well point at a directory.
    // Sorted so which entries survive the cap is the same on every filesystem.
    names = (await readdir(root.dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const out: AgentSkill[] = [];
  for (const entry of names) {
    if (out.length >= MAX_ENTRIES) break;
    // A directory with no readable SKILL.md is the same non-answer as one with a bad header.
    const file = path.join(root.dir, entry, "SKILL.md");
    const text = await head(file);
    if (text === null) continue;
    const header = skillHeader(text);
    // A plugin skill answers to "<plugin>:<dir>" and to nothing else, so its header's name is not the handle.
    const name = root.plugin ? `${root.plugin}:${entry}` : header.name?.trim() || entry;
    out.push({ name, description: oneLine(header.description ?? ""), source: root.source, path: file });
  }
  return out;
}

/**
 * Where installed plugins keep their skills, from the manifest Claude Code
 * writes rather than by walking the plugin cache: the cache holds every
 * version ever fetched, and only the installed one is a skill the CLI would
 * resolve. The manifest key carries the plugin's name, which the CLI prefixes
 * onto every skill the plugin ships, so it travels with the directory.
 */
async function pluginSkillRoots(configDir: string): Promise<SkillRoot[]> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = (manifest as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const roots: SkillRoot[] = [];
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue;
    // "figma@claude-plugins-official" is figma from that marketplace; only the name reaches the prompt.
    const plugin = key.split("@")[0] ?? "";
    // With no name there is no handle to offer, and a wrong "/name" costs more than a missing one.
    if (!plugin) continue;
    for (const install of installs as unknown[]) {
      const installPath = install && typeof install === "object" ? (install as { installPath?: unknown }).installPath : null;
      if (typeof installPath === "string" && installPath) roots.push({ dir: path.join(installPath, "skills"), source: "plugin", plugin });
    }
  }
  return roots.sort((a, b) => a.dir.localeCompare(b.dir)).slice(0, MAX_ENTRIES);
}

/**
 * Every Claude skill this project can name. Claude resolves personal skills
 * before project skills when names overlap.
 * Plugin skills shadow nothing and are shadowed by nothing: the CLI names them
 * "<plugin>:<skill>" and so do we, which puts them in their own namespace. The
 * list is sorted by name because readdir order is not.
 */
async function listClaudeSkills(projectRoot: string, home: string): Promise<AgentSkill[]> {
  const configDir = claudeConfigDir(home);
  const roots: SkillRoot[] = [{ dir: path.join(configDir, "skills"), source: "user" }, { dir: path.join(projectRoot, ".claude", "skills"), source: "project" }, ...(await pluginSkillRoots(configDir))];
  const found = new Map<string, AgentSkill>();
  for (const root of roots) {
    for (const skill of await readSkillDir(root)) {
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ancestors inside the current worktree, from its root toward the current directory. */
async function projectDirectories(projectRoot: string): Promise<string[]> {
  const directories = [path.resolve(projectRoot)];
  while (true) {
    const current = directories[directories.length - 1]!;
    try {
      await stat(path.join(current, ".git"));
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      directories.push(parent);
    }
  }
  return directories.reverse();
}

/** OpenCode V2 identifies a skill by the file or containing directory, not by frontmatter name. */
function openCodeSkillId(file: string, depth: number): string | null {
  if (path.basename(file) === "SKILL.md") return path.basename(path.dirname(file));
  if (depth === 0 && file.endsWith(".md")) return path.basename(file, ".md");
  return null;
}

async function readOpenCodeRoot(root: SkillRoot): Promise<AgentSkill[]> {
  const found: AgentSkill[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_ENTRIES) break;
      const file = path.join(dir, entry.name);
      const kind = entry.isSymbolicLink() ? await stat(file).catch(() => null) : null;
      if (entry.isDirectory() || kind?.isDirectory()) {
        // Depth bounds symlink cycles as well as unexpectedly large skill trees.
        await visit(file, depth + 1);
        continue;
      }
      if (!entry.isFile() && !kind?.isFile()) continue;
      const id = openCodeSkillId(file, depth);
      if (!id) continue;
      const content = await head(file);
      if (content === null) continue;
      const header = skillHeader(content);
      found.push({ name: id, description: oneLine(header.description ?? ""), source: root.source, path: file });
    }
  };
  await visit(root.dir, 0);
  return found;
}

interface ConfiguredSkillSource {
  location: string;
  source: AgentSkill["source"];
}

function configuredSourceLocation(entry: string, projectRoot: string, home: string): string {
  if (entry.startsWith("~/")) return path.join(home, entry.slice(2));
  if (/^https?:\/\//.test(entry)) return entry;
  return path.resolve(projectRoot, entry);
}

/** OpenCode combines skill source arrays from global and project JSONC config files. */
async function configuredOpenCodeSources(projectRoot: string, directories: string[], configDir: string, home: string, env: NodeJS.ProcessEnv): Promise<ConfiguredSkillSource[]> {
  const files = [
    ...["opencode.json", "opencode.jsonc"].map((name) => ({ file: path.join(configDir, name), source: "user" as const })),
    ...(env["OPENCODE_CONFIG"] ? [{ file: env["OPENCODE_CONFIG"], source: "user" as const }] : []),
    ...directories.flatMap((dir) => ["opencode.json", "opencode.jsonc"].map((name) => ({ file: path.join(dir, name), source: "project" as const }))),
    ...directories.flatMap((dir) => ["opencode.json", "opencode.jsonc"].map((name) => ({ file: path.join(dir, ".opencode", name), source: "project" as const }))),
  ];
  const sources: ConfiguredSkillSource[] = [];
  const add = (content: string, source: AgentSkill["source"]) => {
    const config: unknown = parse(content);
    const skills = config && typeof config === "object" && "skills" in config ? config.skills : null;
    if (!Array.isArray(skills)) return;
    for (const entry of skills.slice(0, MAX_ENTRIES)) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      sources.push({ location: configuredSourceLocation(entry, projectRoot, home), source });
    }
  };
  for (const { file, source } of files) {
    try {
      add(await readFile(file, "utf8"), source);
    } catch {
      // A missing or unreadable config contributes no sources.
    }
  }
  if (env["OPENCODE_CONFIG_CONTENT"]) add(env["OPENCODE_CONFIG_CONTENT"], "user");
  return sources;
}

/** Remote catalogs are explicit user configuration; read only their small metadata headers. */
function remoteSkillFile(entry: unknown): { name: string; file: string } | null {
  if (
    !entry ||
    typeof entry !== "object" ||
    !("name" in entry) ||
    typeof entry.name !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(entry.name) ||
    entry.name === "." ||
    entry.name === ".." ||
    !("files" in entry) ||
    !Array.isArray(entry.files)
  )
    return null;
  if (entry.files.includes(`${entry.name}.md`)) return { name: entry.name, file: `${entry.name}.md` };
  if (entry.files.includes("SKILL.md")) return { name: "SKILL", file: "SKILL.md" };
  return null;
}

async function remoteSkill(entry: unknown, base: URL, signal: AbortSignal, source: AgentSkill["source"]): Promise<AgentSkill | null> {
  const file = remoteSkillFile(entry);
  if (!file) return null;
  const folder = (entry as { name: string }).name;
  const url = new URL(`${encodeURIComponent(folder)}/${file.file}`, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const header = skillHeader((await response.text()).slice(0, MAX_SKILL_BYTES));
  return { name: file.name, description: oneLine(header.description ?? ""), source, path: url.href };
}

async function readRemoteOpenCodeRoot(root: ConfiguredSkillSource): Promise<AgentSkill[]> {
  const found: AgentSkill[] = [];
  try {
    const base = new URL(root.location.endsWith("/") ? root.location : `${root.location}/`);
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(new URL("index.json", base), { signal });
    if (!response.ok) return [];
    const catalog: unknown = await response.json();
    const entries = catalog && typeof catalog === "object" && "skills" in catalog ? catalog.skills : null;
    if (!Array.isArray(entries)) return [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      const skill = await remoteSkill(entry, base, signal, root.source);
      if (skill) found.push(skill);
    }
  } catch {
    // Offline or inaccessible catalogs do not hide local skills.
  }
  return found;
}

/** Apply OpenCode's source priority so only the definition it would load is shown. */
async function listOpenCodeSkills(projectRoot: string, home: string, env: NodeJS.ProcessEnv): Promise<AgentSkill[]> {
  const directories = await projectDirectories(projectRoot);
  const configDir = path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "opencode");
  const claudeEnabled = !env["OPENCODE_DISABLE_CLAUDE_CODE"] && !env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"];
  const roots: SkillRoot[] = [
    ...(claudeEnabled
      ? [{ dir: path.join(home, ".claude", "skills"), source: "user" as const }, ...directories.map((dir) => ({ dir: path.join(dir, ".claude", "skills"), source: "project" as const }))]
      : []),
    { dir: path.join(home, ".agents", "skills"), source: "user" },
    ...directories.map((dir) => ({ dir: path.join(dir, ".agents", "skills"), source: "project" as const })),
    { dir: path.join(configDir, "skills"), source: "user" },
    ...directories.map((dir) => ({ dir: path.join(dir, ".opencode", "skill"), source: "project" as const })),
    ...directories.map((dir) => ({ dir: path.join(dir, ".opencode", "skills"), source: "project" as const })),
    ...(env["OPENCODE_CONFIG_DIR"] ? [{ dir: path.join(env["OPENCODE_CONFIG_DIR"], "skills"), source: "user" as const }] : []),
  ];
  const found = new Map<string, AgentSkill>();
  for (const root of roots) for (const skill of await readOpenCodeRoot(root)) found.set(skill.name, skill);
  for (const source of await configuredOpenCodeSources(projectRoot, directories, configDir, home, env)) {
    const skills = /^https?:\/\//.test(source.location) ? await readRemoteOpenCodeRoot(source) : await readOpenCodeRoot({ dir: source.location, source: source.source });
    for (const skill of skills) found.set(skill.name, skill);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills a selected harness offers in one project. */
export async function listSkills({
  projectRoot,
  agent,
  home = os.homedir(),
  env = process.env,
  nativeDiscovery = true,
}: {
  projectRoot: string;
  agent: HarnessId;
  home?: string;
  env?: NodeJS.ProcessEnv;
  nativeDiscovery?: boolean;
}): Promise<AgentSkill[]> {
  if (agent === "codex") return listCodexSkills(projectRoot);
  if (agent === "opencode") {
    const [native, disk] = await Promise.all([nativeDiscovery ? listNativeOpenCodeSkills(projectRoot) : Promise.resolve(null), listOpenCodeSkills(projectRoot, home, env)]);
    if (!native) return disk;
    return openCodeSkillRows(native, new Map(disk.map((skill) => [skill.path, skill.source])), home);
  }
  return listClaudeSkills(projectRoot, home);
}

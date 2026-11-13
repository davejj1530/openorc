import { harnessCatalog, type AgentSkill, type FileScope, type HarnessId, type SkillFile } from "@openorc/protocol";

/** Where the page reads skills: one agent's, as it resolves them in one project. Reads wait while the page is hidden. */
export interface SkillsPlace {
  agent: HarnessId;
  scope: FileScope;
  projectId: string;
  active: boolean;
}

export const listParams = (place: SkillsPlace) => ({ scope: place.scope, agent: place.agent });
export const skillRef = (place: SkillsPlace, skill: AgentSkill) => ({ agent: place.agent, scope: place.scope, skill: skill.path });

/** A built-in has no file, so its name is what tells it apart. */
export const skillKey = (skill: AgentSkill) => skill.path || `${skill.source}:${skill.name}`;

const skillSources = [
  { id: "project", title: "This project", addedBy: "Project" },
  { id: "user", title: "Yours", addedBy: "You" },
  { id: "plugin", title: "Plugins", addedBy: "Plugin" },
  { id: "system", title: "Built in", addedBy: "Built in" },
] satisfies { id: AgentSkill["source"]; title: string; addedBy: string }[];

export const addedBy = (skill: AgentSkill) => skillSources.find((source) => source.id === skill.source)?.addedBy ?? "";

// Skill frontmatter sometimes uses inline Markdown; names and lists are plain text.
export const readableDescription = (description: string) =>
  description
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const skillTitle = (skill: AgentSkill) => skill.displayName || skill.name;
export const skillLine = (skill: AgentSkill) => skill.shortDescription || readableDescription(skill.description);

export interface SkillGroup {
  id: AgentSkill["source"];
  title: string;
  items: AgentSkill[];
}

/** The skills that answer the search, by where they come from, this project's first. */
export function groupSkills(skills: readonly AgentSkill[], term: string): SkillGroup[] {
  const needle = term.trim().toLocaleLowerCase();
  const matching = needle ? skills.filter((skill) => `${skill.name} ${skill.displayName ?? ""} ${skill.description}`.toLocaleLowerCase().includes(needle)) : skills;
  return skillSources.map(({ id, title }) => ({ id, title, items: matching.filter((skill) => skill.source === id) })).filter((group) => group.items.length > 0);
}

/** What a message types to call a skill: Codex `$name`, Claude `/name`, Oh My Pi `/skill:name`. OpenCode loads skills through its own tool, so it has none. */
const callPrefixes: Record<HarnessId, string | null> = { codex: "$", claude: "/", opencode: null, omp: "/skill:", cursor: "/", pi: "/skill:", antigravity: "/", fx: "$" };

export function skillCall(agent: HarnessId, skill: AgentSkill): string | null {
  const prefix = callPrefixes[agent];
  return prefix === null ? null : `${prefix}${skill.name}`;
}

/** What a new thread starts with to try the skill: its call, or for OpenCode, asking for it by name. */
export const tryPrompt = (agent: HarnessId, skill: AgentSkill) => {
  const call = skillCall(agent, skill);
  return call ? `${call} ` : `Use the ${skill.name} skill. `;
};

/** What a new thread starts with to have its agent write a skill with the user. */
export const createPrompt = (agent: HarnessId) => {
  const name = harnessCatalog[agent].name;
  return `Help me write a new ${name} skill. Ask me what it should do and when it should be used, then create it where ${name} looks for my skills.`;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const parentFolder = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** The file a skill is defined in, by its place in the skill's folder: `SKILL.md`, or a command's own Markdown file. */
export const mainFile = (skill: AgentSkill) => fileName(skill.path);

/** The skill's folder, with the home folder as `~`. */
export const skillFolder = (skill: AgentSkill) => parentFolder(skill.path).replace(/^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, "~");
export const absoluteFolder = (skill: AgentSkill) => parentFolder(skill.path);

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A Markdown file's YAML header as flat `key: value` pairs, and the text after it. */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair?.[1]) fields[pair[1]] = (pair[2] ?? "").replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: text.slice(match[0].length).replace(/^\s*\n/, "") };
}

/** How a skill starts: the call a message types, and whether the agent picks it up by itself when a task fits. */
export interface SkillTrigger {
  call: string | null;
  auto: boolean;
}

/** The file of a skill that says how it starts: Claude's header in its own file, Codex's `agents/openai.yaml`. */
export function triggerSettingsFile(agent: HarnessId, skill: AgentSkill): string | null {
  const files: Record<HarnessId, string | null> = { claude: mainFile(skill), codex: "agents/openai.yaml", opencode: null, omp: null, cursor: mainFile(skill), pi: null, antigravity: null, fx: null };
  return files[agent];
}

/**
 * Read from that file: Claude's `disable-model-invocation` and `user-invocable`, Codex's `allow_implicit_invocation`.
 * OpenCode's agent always chooses for itself.
 */
export function skillTrigger(agent: HarnessId, skill: AgentSkill, settings: string): SkillTrigger {
  const call = skillCall(agent, skill);
  if (agent === "claude") {
    const { fields } = splitFrontmatter(settings);
    return { call: fields["user-invocable"] === "false" ? null : call, auto: fields["disable-model-invocation"] !== "true" };
  }
  if (agent === "codex") return { call, auto: !/^\s*allow_implicit_invocation:\s*false\b/m.test(settings) };
  return { call, auto: true };
}

export interface SkillTreeEntry {
  path: string;
  name: string;
  kind: SkillFile["kind"];
  children: SkillTreeEntry[];
}

const byName = (a: SkillTreeEntry, b: SkillTreeEntry) => a.name.localeCompare(b.name, undefined, { numeric: true });

function sortEntries(entries: SkillTreeEntry[], main: string): SkillTreeEntry[] {
  const rank = (entry: SkillTreeEntry) => {
    if (entry.path === main) return 0;
    return entry.kind === "directory" ? 1 : 2;
  };
  return entries.sort((a, b) => rank(a) - rank(b) || byName(a, b)).map((entry) => ({ ...entry, children: sortEntries(entry.children, main) }));
}

/** The skill's folder as a tree: its main file first, then folders, then the other files. */
export function skillTree(files: readonly SkillFile[], main: string): SkillTreeEntry[] {
  const entries = new Map<string, SkillTreeEntry>(files.map((file) => [file.path, { path: file.path, name: fileName(file.path), kind: file.kind, children: [] }]));
  const roots: SkillTreeEntry[] = [];
  for (const entry of entries.values()) {
    const parent = entry.path.includes("/") ? entries.get(entry.path.slice(0, entry.path.lastIndexOf("/"))) : undefined;
    (parent?.children ?? roots).push(entry);
  }
  return sortEntries(roots, main);
}

/** The folders that hold a file, outermost first: `references` for `references/sources.md`. */
export function parentFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** A skill name as typed: lowercase words joined by hyphens. */
export const skillNameInput = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
export const finalSkillName = (value: string) => skillNameInput(value).replace(/-+/g, "-").replace(/^-|-$/g, "");

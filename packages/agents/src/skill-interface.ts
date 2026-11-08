/**
 * What apps show of a skill beyond its SKILL.md header: a display name, a line for lists and an image. Codex reads them
 * from `agents/openai.yaml` in the skill's folder, and so does OpenOrc for every agent's skills.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { JSON_SCHEMA, dump, load } from "js-yaml";
import type { AgentSkill } from "@openorc/protocol";

/** The interface file, by its place in a skill's folder. */
export const SKILL_INTERFACE_FILE = "agents/openai.yaml";

/** Real skill images are a few kilobytes; a larger one is left out rather than sent with every listing. */
export const MAX_SKILL_ICON_BYTES = 512 * 1024;

/** The images a skill may show, by extension, and the type each is served as. */
export const SKILL_ICON_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

/** Hand-written interface files run to a few lines; anything this large is not one. */
const MAX_INTERFACE_BYTES = 64 * 1024;

export type SkillInterface = Pick<AgentSkill, "displayName" | "shortDescription" | "icon">;

/** A skill's folder, the one holding its SKILL.md; null for a skill that is a single Markdown file, as a command is. */
export function skillFolderOf(file: string): string | null {
  return path.isAbsolute(file) && /^skill\.md$/i.test(path.basename(file)) ? path.dirname(file) : null;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Whether `file` is inside `folder`, by path alone; callers compare real paths when links matter. */
export function within(folder: string, file: string): boolean {
  const local = path.relative(folder, file);
  return local !== "" && !local.startsWith(`..${path.sep}`) && local !== ".." && !path.isAbsolute(local);
}

/** An image file as a data URL, when it is a known image type, no larger than the cap, and inside `folder` even through links. */
export async function skillIconDataUrl(folder: string, file: string): Promise<string | undefined> {
  const type = SKILL_ICON_TYPES[path.extname(file).slice(1).toLowerCase()];
  if (!type) return undefined;
  try {
    const [root, real] = await Promise.all([realpath(folder), realpath(path.resolve(folder, file))]);
    if (!within(root, real)) return undefined;
    const info = await stat(real);
    if (!info.isFile() || info.size > MAX_SKILL_ICON_BYTES) return undefined;
    return `data:${type};base64,${(await readFile(real)).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** The first of `files` that reads as an image; the small one is listed first, as list rows use it. */
export async function firstSkillIcon(folder: string, files: unknown[]): Promise<string | undefined> {
  for (const file of files) {
    const icon = typeof file === "string" && file ? await skillIconDataUrl(folder, file) : undefined;
    if (icon) return icon;
  }
  return undefined;
}

/** A YAML file's top-level map, or an empty one for anything else. JSON's schema keeps every value as written: `on` stays text. */
function yamlMap(source: string): Record<string, unknown> {
  try {
    const value = load(source, { schema: JSON_SCHEMA });
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function interfaceText(folder: string): Promise<string | null> {
  const file = path.join(folder, SKILL_INTERFACE_FILE);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_INTERFACE_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The skill's interface as its folder describes it; a missing or unreadable file describes nothing. */
export async function readSkillInterface(folder: string): Promise<SkillInterface> {
  const source = await interfaceText(folder);
  if (source === null) return {};
  const block = yamlMap(source)["interface"];
  if (!isRecord(block)) return {};
  const displayName = text(block["display_name"]);
  const shortDescription = text(block["short_description"]);
  const icon = await firstSkillIcon(folder, [block["icon_small"], block["icon_large"]]);
  return { ...(displayName ? { displayName } : {}), ...(shortDescription ? { shortDescription } : {}), ...(icon ? { icon } : {}) };
}

/** The map to edit; a file that is not one is the user's to fix, never to overwrite. */
function editableMap(source: string): Record<string, unknown> {
  const unreadable = new Error(`This skill's ${SKILL_INTERFACE_FILE} could not be read. Fix it and try again.`);
  let value: unknown;
  try {
    value = load(source, { schema: JSON_SCHEMA });
  } catch {
    throw unreadable;
  }
  if (value === undefined || value === null) return {};
  if (isRecord(value)) return value;
  throw unreadable;
}

const writeYaml = (value: Record<string, unknown>) => dump(value, { schema: JSON_SCHEMA, quotingType: '"', forceQuotes: true, lineWidth: -1 });

/**
 * The interface file's text with the skill's image at `icon`, a path in the skill's folder such as `./assets/icon.png`,
 * or with no image for null. Both sizes name the one file. Every other key stays; null when there is nothing to write.
 */
export function withSkillIcon(source: string | null, icon: string | null): string | null {
  const document = source === null ? {} : editableMap(source);
  const block = isRecord(document["interface"]) ? { ...document["interface"] } : {};
  // Nothing to take away leaves the file exactly as its author wrote it.
  if (icon === null && !("icon_small" in block) && !("icon_large" in block)) return source;
  delete block["icon_small"];
  delete block["icon_large"];
  if (icon) Object.assign(block, { icon_small: icon, icon_large: icon });
  const next: Record<string, unknown> = { ...document, interface: block };
  if (!Object.keys(block).length) delete next["interface"];
  return Object.keys(next).length ? writeYaml(next) : "";
}

/** A new skill's SKILL.md: the header agents list it by, then its instructions. */
export function newSkillText(name: string, description: string, instructions: string): string {
  const header = dump({ name, description }, { quotingType: '"', lineWidth: -1 });
  const body = instructions.trim();
  return `---\n${header}---\n${body ? `\n${body}\n` : ""}`;
}

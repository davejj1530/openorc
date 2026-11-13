import path from "node:path";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";

/**
 * Claude Code's per-skill setting in settings.json, by skill name: "on", "name-only", "user-invocable-only" or "off".
 * Only "off" keeps a skill from running at all; absent means on.
 */
const KEY = "skillOverrides";
const UNREADABLE = "Claude Code's settings file could not be read. Fix it and try again.";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The user's settings, then the project's and the project's local ones, each overriding the one before for a skill. */
function settingsFiles(configDir: string, projectRoot: string): string[] {
  return [path.join(configDir, "settings.json"), path.join(projectRoot, ".claude", "settings.json"), path.join(projectRoot, ".claude", "settings.local.json")];
}

async function overridesIn(file: string): Promise<[string, unknown][]> {
  try {
    const overrides = (await readConfigFile(file, UNREADABLE)).value[KEY];
    return isRecord(overrides) ? Object.entries(overrides) : [];
  } catch {
    return [];
  }
}

/** The names of the skills Claude Code has turned off in `projectRoot`, its settings merged as it merges them. */
export async function claudeSkillsOff(configDir: string, projectRoot: string): Promise<Set<string>> {
  const merged = new Map<string, unknown>();
  for (const entries of await Promise.all(settingsFiles(configDir, projectRoot).map(overridesIn))) for (const [name, value] of entries) merged.set(name, value);
  return new Set([...merged].filter(([, value]) => value === "off").map(([name]) => name));
}

/**
 * Turns a skill off, or back on, in the user's settings in `configDir`. Turning it on removes only an "off"; a skill
 * listed without its description stays that way. Every other key and every other skill's choice stays as written.
 */
export async function setClaudeSkillOff(configDir: string, name: string, off: boolean): Promise<void> {
  const file = path.join(configDir, "settings.json");
  const { text, value } = await readConfigFile(file, UNREADABLE);
  const overrides = isRecord(value[KEY]) ? value[KEY] : {};
  if ((overrides[name] === "off") === off) return;
  const others = Object.keys(overrides).some((key) => key !== name);
  const edited = off ? editedConfig(text, [KEY, name], "off") : editedConfig(text, others ? [KEY, name] : [KEY], undefined);
  await replaceFile(file, edited);
}

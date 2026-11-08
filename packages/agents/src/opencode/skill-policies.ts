import { parse } from "jsonc-parser";
import { editedConfig, readConfigFile, replaceFile } from "../config-file.js";

/**
 * OpenCode 2 turns skills off through `policies`, an ordered list in its configuration files of
 * `{ "action": "skill.use", "resource": "<skill id or pattern>", "effect": "deny" }`. The last rule that matches a skill
 * decides, and a denied skill is left out of the agent's skills. Older files name skills as `integration.use` of
 * `skill:<id>`, which OpenCode still reads.
 */
export interface SkillRule {
  resource: string;
  effect: "allow" | "deny";
}

const UNREADABLE = "OpenCode's configuration file could not be read. Fix it and try again.";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function skillRule(entry: unknown): SkillRule | null {
  if (!isRecord(entry) || typeof entry["resource"] !== "string" || (entry["effect"] !== "allow" && entry["effect"] !== "deny")) return null;
  if (entry["action"] === "skill.use") return { resource: entry["resource"], effect: entry["effect"] };
  if (entry["action"] === "integration.use" && entry["resource"].startsWith("skill:")) return { resource: entry["resource"].slice("skill:".length), effect: entry["effect"] };
  return null;
}

/** A configuration's skill rules: experimental policies first, as OpenCode joins them, then the top-level ones. */
function rulesIn(config: unknown): SkillRule[] {
  if (!isRecord(config)) return [];
  const experimental = isRecord(config["experimental"]) ? config["experimental"]["policies"] : undefined;
  return [experimental, config["policies"]].flatMap((list) => (Array.isArray(list) ? list.map(skillRule).filter((rule): rule is SkillRule => rule !== null) : []));
}

/** The skill rules of the configuration texts, in the order OpenCode applies them. */
export function openCodeSkillRules(texts: string[]): SkillRule[] {
  return texts.flatMap((text) => rulesIn(parse(text, [], { allowTrailingComma: true })));
}

/** OpenCode's resource patterns: `*` stands for any run of characters and `?` for one. */
function matches(pattern: string, id: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "s").test(id);
}

export function openCodeSkillDenied(rules: SkillRule[], id: string): boolean {
  return rules.findLast((rule) => matches(rule.resource, id))?.effect === "deny";
}

/**
 * Turns a skill off with a rule of its own at the end of `file`'s policies, or back on by removing the rules that name
 * it exactly. Rules for other skills and everything else in the file stay as written.
 */
export async function setOpenCodeSkillDenied(file: string, id: string, deny: boolean): Promise<void> {
  const { text, value } = await readConfigFile(file, UNREADABLE);
  const policies: unknown[] = Array.isArray(value["policies"]) ? value["policies"] : [];
  const kept = policies.filter((entry) => skillRule(entry)?.resource !== id);
  const next = deny ? [...kept, { action: "skill.use", resource: id, effect: "deny" }] : kept;
  if (JSON.stringify(next) === JSON.stringify(policies)) return;
  await replaceFile(file, editedConfig(text, ["policies"], next.length ? next : undefined));
}

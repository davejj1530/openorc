import path from "node:path";
import type { AgentSkill } from "@openorc/protocol";
import { firstSkillIcon } from "../skill-interface.js";
import { withCodexConnection } from "./connection.js";

interface CodexSkill {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  path?: unknown;
  scope?: unknown;
  enabled?: unknown;
  pluginId?: unknown;
  interface?: { displayName?: unknown; shortDescription?: unknown; iconSmall?: unknown; iconLarge?: unknown } | null;
}

interface CodexSkillsResponse {
  data?: { cwd?: unknown; skills?: CodexSkill[]; errors?: unknown[] }[];
}

/** Codex owns discovery, including bundled and installed plugin skills, and which of them are turned off. */
export async function listCodexSkills(projectRoot: string): Promise<AgentSkill[]> {
  return withCodexConnection({}, async (rpc) => {
    const response = await rpc.request<CodexSkillsResponse>("skills/list", { cwds: [projectRoot], forceReload: true }, 10_000);
    const result = response.data?.find((entry) => entry.cwd === projectRoot);
    if (!result?.skills || result.errors?.length) throw new Error("Codex could not list skills for this project.");
    return codexSkillRows(result.skills);
  });
}

/** Turns a skill on or off in Codex's own config, by its file; answers whether Codex now uses it. */
export async function setCodexSkillEnabled(file: string, enabled: boolean): Promise<boolean> {
  return withCodexConnection({}, async (rpc) => (await rpc.request<{ effectiveEnabled: boolean }>("skills/config/write", { path: file, enabled }, 10_000)).effectiveEnabled);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined);

/** Every skill Codex knows, turned off or not; the app-server has already applied its precedence rules. */
export async function codexSkillRows(rows: CodexSkill[]): Promise<AgentSkill[]> {
  const skills = await Promise.all(rows.filter((skill) => typeof skill.name === "string" && typeof skill.path === "string").map(codexSkillRow));
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function codexSkillRow(skill: CodexSkill): Promise<AgentSkill> {
  const file = skill.path as string;
  const face = skill.interface ?? {};
  const displayName = text(face.displayName);
  const shortDescription = text(face.shortDescription) ?? text(skill.shortDescription);
  // Codex names its images by absolute path, relative files already resolved against the skill's folder.
  const icon = await firstSkillIcon(path.dirname(file), [face.iconSmall, face.iconLarge]);
  const source = codexSkillSource(skill);
  return {
    name: skill.name as string,
    description: text(skill.description) ?? "",
    path: file,
    source,
    ...(displayName ? { displayName } : {}),
    ...(shortDescription ? { shortDescription } : {}),
    ...(icon ? { icon } : {}),
    enabled: skill.enabled === true,
    editable: source === "user" || source === "project",
  };
}

/** Codex's scopes: the user's, the repository's, its own bundled `system` ones and an administrator's. */
function codexSkillSource(skill: CodexSkill): AgentSkill["source"] {
  if (skill.pluginId) return "plugin";
  if (skill.scope === "repo") return "project";
  if (skill.scope === "system" || skill.scope === "admin") return "system";
  return "user";
}

import type { AgentSkill } from "@openorc/protocol";
import { withCodexConnection } from "./connection.js";

interface CodexSkill {
  name?: unknown;
  description?: unknown;
  path?: unknown;
  scope?: unknown;
  enabled?: unknown;
  pluginId?: unknown;
}

interface CodexSkillsResponse {
  data?: { cwd?: unknown; skills?: CodexSkill[]; errors?: unknown[] }[];
}

/** Codex owns discovery, including bundled and installed plugin skills. */
export async function listCodexSkills(projectRoot: string): Promise<AgentSkill[]> {
  return withCodexConnection({}, async (rpc) => {
    const response = await rpc.request<CodexSkillsResponse>("skills/list", { cwds: [projectRoot], forceReload: true }, 10_000);
    const result = response.data?.find((entry) => entry.cwd === projectRoot);
    if (!result?.skills || result.errors?.length) throw new Error("Codex could not list skills for this project.");
    return codexSkillRows(result.skills);
  });
}

/** Keep only skills Codex can invoke; the app-server has already applied its precedence rules. */
export function codexSkillRows(rows: CodexSkill[]): AgentSkill[] {
  return rows
    .filter((skill) => skill.enabled === true && typeof skill.name === "string" && typeof skill.path === "string")
    .map((skill) => ({
      name: skill.name as string,
      description: typeof skill.description === "string" ? skill.description.replace(/\s+/g, " ").trim() : "",
      path: skill.path as string,
      source: codexSkillSource(skill),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function codexSkillSource(skill: CodexSkill): AgentSkill["source"] {
  if (skill.pluginId) return "plugin";
  if (skill.scope === "project") return "project";
  if (skill.scope === "system") return "system";
  return "user";
}

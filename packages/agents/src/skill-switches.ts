import os from "node:os";
import type { AgentSkill, HarnessId } from "@openorc/protocol";
import { claudeConfigDir } from "./claude/config-dir.js";
import { claudeSkillsOff, setClaudeSkillOff } from "./claude/skill-overrides.js";
import { setCodexSkillEnabled } from "./codex/skills.js";
import { openCodeConfigFile } from "./opencode/connectors.js";
import { openCodeSkillDenied, setOpenCodeSkillDenied } from "./opencode/skill-policies.js";
import { openCodeSkillRulesFor } from "./skills.js";

/**
 * Turns a listed skill on or off where its agent keeps that choice for the user: Codex in its own config, Claude Code in
 * the settings.json of the account's config folder, OpenCode in its user configuration's policies. Answers whether the
 * agent now uses the skill in `projectRoot`, where a project's own settings may still decide otherwise.
 */
export async function setSkillEnabled({
  agent,
  skill,
  enabled,
  projectRoot,
  home = os.homedir(),
  env = process.env,
}: {
  agent: HarnessId;
  skill: Pick<AgentSkill, "name" | "path">;
  enabled: boolean;
  projectRoot: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (agent === "codex") return setCodexSkillEnabled(skill.path, enabled);
  if (agent === "claude") {
    const configDir = claudeConfigDir(home, env);
    await setClaudeSkillOff(configDir, skill.name, !enabled);
    return !(await claudeSkillsOff(configDir, projectRoot)).has(skill.name);
  }
  await setOpenCodeSkillDenied(openCodeConfigFile({ ...env, HOME: home }), skill.name, !enabled);
  return !openCodeSkillDenied(await openCodeSkillRulesFor(projectRoot, home, env), skill.name);
}

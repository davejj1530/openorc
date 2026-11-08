import { execFile } from "node:child_process";
import type { AgentSkill } from "@openorc/protocol";
import { launchCommand } from "../command-launch.js";
import { inFolder } from "../launch-environment.js";

interface ListedSkill {
  name?: unknown;
  description?: unknown;
  filePath?: unknown;
  source?: unknown;
}

/** Providers whose skills come in packages someone else maintains. */
const PACKAGED = new Set(["claude-plugins", "omp-plugins", "agent-plugins", "skillshare"]);

/** Where Oh My Pi found a skill, from its `<provider>:<user|project>` source. */
function skillSource(source: unknown): AgentSkill["source"] {
  const [provider, scope] = typeof source === "string" ? source.split(":") : [];
  if (provider && PACKAGED.has(provider)) return "plugin";
  return scope === "project" ? "project" : "user";
}

/** The skills in an `omp skill list --json` answer, which has applied Oh My Pi's own precedence and exclusions. */
export function ompSkillRows(output: string): AgentSkill[] {
  const parsed = JSON.parse(output) as { skills?: unknown };
  if (!Array.isArray(parsed.skills)) throw new Error("Oh My Pi did not list its skills.");
  return (parsed.skills as ListedSkill[])
    .filter((skill) => typeof skill.name === "string" && typeof skill.filePath === "string")
    .map((skill) => ({
      name: skill.name as string,
      description: typeof skill.description === "string" ? skill.description.replace(/\s+/g, " ").trim() : "",
      path: skill.filePath as string,
      source: skillSource(skill.source),
    }));
}

/** The skills Oh My Pi loads in a project, as it lists them itself from that folder. */
export function listNativeOmpSkills(projectRoot: string, binary: string, env: NodeJS.ProcessEnv): Promise<AgentSkill[]> {
  const command = launchCommand(binary, ["skill", "list", "--json"]);
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { ...command.options, cwd: projectRoot, env: inFolder({ ...env }, projectRoot), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Oh My Pi could not list its skills: ${error.message.split("\n")[0]}`));
      else {
        try {
          resolve(ompSkillRows(String(stdout)));
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
        }
      }
    });
  });
}

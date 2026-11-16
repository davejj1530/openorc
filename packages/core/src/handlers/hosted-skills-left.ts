import type { HostedSkillsLeftRpcResults } from "@openorc/protocol";
import type { HostedSkills } from "../services/hosted-skills.js";
import type { Handlers } from "./types.js";

/** The skills of an agent's last cloud set that this Mac left out, with why: none before a cloud send. */
export function createHostedSkillsLeftHandlers(skills: () => HostedSkills | null): Pick<Handlers, keyof HostedSkillsLeftRpcResults> {
  return { "hostedSkills.leftOut": async ({ agent }) => skills()?.leftOut(agent) ?? [] };
}

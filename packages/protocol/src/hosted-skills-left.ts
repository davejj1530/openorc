import { z } from "zod";
import { HarnessId } from "./harness.js";

/** A skill of the person's left out of a cloud turn because this Mac could not read it, and why, in plain words. */
export type LeftOutSkill = { name: string; cause: string };

/** Window-only: the skills of an agent's last cloud set that this Mac left out. */
export const hostedSkillsLeftRpcParams = {
  "hostedSkills.leftOut": z.object({ agent: HarnessId }).strict(),
};
export interface HostedSkillsLeftRpcResults {
  "hostedSkills.leftOut": LeftOutSkill[];
}

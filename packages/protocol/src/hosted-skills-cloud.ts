import { z } from "zod";
import { HarnessId } from "./harness.js";

/**
 * A skill of the person's left out of a cloud turn because this Mac could not read it, and why, in plain words. With no
 * `name`, every skill of the agent's was left out: this Mac could not list them.
 */
export type LeftOutSkill = { name: string | null; cause: string };

/**
 * One of an agent's own skills on this Mac as its cloud turns would get it: whether it goes (`on`, the person's choice
 * for the cloud alone), its size on disk, and why it can't go when this Mac can't read it (then `bytes` is null).
 */
export type CloudSkill = { name: string; description: string; bytes: number | null; on: boolean; cause: string | null };

/** Window-only: an agent's skills for the cloud, the person's choice of which go, and the ones its last set left out. */
export const hostedSkillsCloudRpcParams = {
  "hostedSkills.leftOut": z.object({ agent: HarnessId }).strict(),
  "hostedSkills.list": z.object({ agent: HarnessId }).strict(),
  "hostedSkills.choose": z.object({ agent: HarnessId, names: z.array(z.string().min(1)).max(1000), on: z.boolean() }).strict(),
};
export interface HostedSkillsCloudRpcResults {
  "hostedSkills.leftOut": LeftOutSkill[];
  "hostedSkills.list": CloudSkill[];
  "hostedSkills.choose": CloudSkill[];
}

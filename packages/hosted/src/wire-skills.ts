import { z } from "zod";
import type { Route } from "./wire.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const keptSkill = z.object({ name: z.string().min(1), digest, bytes: z.number().int().nonnegative() });

/** The answer to a set: kept, or the packs the server lacks, with nothing changed. */
export const skillSetAnswer = z.discriminatedUnion("state", [
  z.object({ state: z.literal("kept"), digest, skills: z.array(keptSkill) }),
  z.object({ state: z.literal("missing"), digests: z.array(digest).min(1) }),
]);
export type SkillSetAnswer = z.infer<typeof skillSetAnswer>;

const keptPack = z.object({ digest, name: z.string().min(1), bytes: z.number().int().nonnegative(), files: z.number().int().positive() });
export type KeptSkillPack = z.infer<typeof keptPack>;

/** A person's own skills for their cloud turns: the set one agent's turns get, and one skill's pack by its digest. */
export const SKILL_ROUTES = {
  set: (agent: string): Route<SkillSetAnswer> => ({ method: "PUT", path: `/hosted/skills/${encodeURIComponent(agent)}`, reply: skillSetAnswer }),
  pack: (packDigest: string): Route<KeptSkillPack> => ({ method: "PUT", path: `/hosted/skill-packs/${encodeURIComponent(packDigest)}`, reply: keptPack }),
};

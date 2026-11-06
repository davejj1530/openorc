import { z } from "zod";
import type { CloudBrainCopy } from "./cloud-brain.js";
import { HarnessId } from "./harness.js";

/**
 * What cloud sessions carry besides a project's own files: the user's own skills chosen for them, and each project's
 * cloud environment. Desktop-only, like the rest of cloud.*.
 */

/** One of the user's own skills for an agent, and whether it goes to cloud sessions. */
export interface CloudSkill {
  name: string;
  description: string;
  chosen: boolean;
}

/** The user's own skills, by agent, as Settings lists them for the cloud; `error` when the agent could not list its own. */
export interface CloudSkills {
  agents: { agent: HarnessId; skills: CloudSkill[]; error: string | null }[];
}

/** A project's cloud environment by name. Its values stay in protected storage and are never read back. */
export interface CloudEnv {
  projectId: string;
  names: string[];
}

/** The variables a project's .env files hold, to fill its cloud environment from; nothing is saved by reading them. */
export interface CloudEnvFile {
  /** The files read, relative to the project. */
  files: string[];
  entries: { name: string; value: string }[];
}

/** The most variables a project's cloud environment holds, and the longest value. */
export const CLOUD_ENV_LIMITS = { entries: 100, value: 32_768 } as const;

const ProjectId = z.string().min(1).max(200);

export const cloudCarryRpcParams = {
  /** The user's own skills for each agent, and which go to cloud sessions. */
  "cloud.skills": z.object({}),
  /** Sends one of the user's own skills to cloud sessions, or keeps it on this Mac. */
  "cloud.skills.choose": z.object({ agent: HarnessId, name: z.string().min(1).max(100), on: z.boolean() }).strict(),
  /** A project's cloud environment, by name only. */
  "cloud.env": z.object({ projectId: ProjectId }).strict(),
  /** Replaces a project's cloud environment. A row with no value keeps the value saved under its name. */
  "cloud.env.set": z
    .object({
      projectId: ProjectId,
      entries: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(CLOUD_ENV_LIMITS.value).optional() }).strict()).max(CLOUD_ENV_LIMITS.entries),
    })
    .strict(),
  /** What the project's .env files hold, to fill its cloud environment from. Saves nothing. */
  "cloud.env.fromFile": z.object({ projectId: ProjectId }).strict(),
  /** The branch and commit a copy of the project on the cloud brain would take now. */
  "cloud.brain.copy": z.object({ projectId: ProjectId }).strict(),
};

export interface CloudCarryRpcResults {
  "cloud.skills": CloudSkills;
  "cloud.skills.choose": CloudSkills;
  "cloud.env": CloudEnv;
  "cloud.env.set": CloudEnv;
  "cloud.env.fromFile": CloudEnvFile;
  "cloud.brain.copy": CloudBrainCopy;
}

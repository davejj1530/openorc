import { projects, type Db } from "@openorc/db";
import { projectDotEnv, type CloudProjectEnv } from "../services/cloud-env.js";
import type { CloudSkills } from "../services/cloud-skills.js";
import type { Handlers } from "./types.js";

type CarryMethod = "cloud.skills" | "cloud.skills.choose" | "cloud.env" | "cloud.env.set" | "cloud.env.fromFile";

interface Dependencies {
  db: Db;
  env: CloudProjectEnv;
  /** Null on a cloud brain, which keeps the skills its Mac chose. */
  skills: CloudSkills | null;
}

const ON_THE_MAC = "Skills for cloud sessions are chosen on the Mac.";

/** What cloud sessions carry besides a project's files: the user's own skills chosen for them, and each project's environment. */
export function createCloudCarryHandlers({ db, env, skills }: Dependencies): Pick<Handlers, CarryMethod> {
  const project = (id: string) => {
    const found = projects.get(db, id);
    if (!found) throw new Error("That project is no longer in OpenOrc.");
    return found;
  };
  const chooser = () => {
    if (!skills) throw new Error(ON_THE_MAC);
    return skills;
  };
  return {
    "cloud.skills": () => chooser().catalog(),
    "cloud.skills.choose": ({ agent, name, on }) => chooser().choose(agent, name, on),
    "cloud.env": async ({ projectId }) => ({ projectId, names: await env.names(project(projectId).id) }),
    "cloud.env.set": async ({ projectId, entries }) => ({ projectId, names: await env.set(project(projectId).id, entries) }),
    "cloud.env.fromFile": ({ projectId }) => projectDotEnv(project(projectId).rootPath),
  };
}

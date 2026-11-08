import { realpath } from "node:fs/promises";
import path from "node:path";
import { listSkills, setSkillEnabled, skillFolderOf, type AgentLaunchEnvironment } from "@openorc/agents";
import { audit, type Db } from "@openorc/db";
import { harnessName, type AgentSkill, type FileScope, type HarnessId } from "@openorc/protocol";
import { conversationFolder, type ConversationFolder } from "../services/conversation-folder.js";
import type { FileService } from "../services/files.js";
import { listSkillFiles, readSkillFile, skillHome, writeSkillFile } from "../services/skill-files.js";
import { createSkill, holdsOtherSkills, importSkill, removalTarget, setSkillIcon, skillPlace } from "../services/skill-library.js";
import type { Handlers } from "./types.js";

type SkillMethod = "skills.list" | "skills.files" | "skills.readFile" | "skills.writeFile" | "skills.setEnabled" | "skills.setIcon" | "skills.create" | "skills.import" | "skills.remove";

type Dependencies = {
  db: Db;
  files: Pick<FileService, "read" | "save">;
  claudeEnvironment?: (id?: string) => NodeJS.ProcessEnv;
  /** How a Claude run of that account starts, so the CLI itself can say which commands it has. */
  claudeLaunch?: (id?: string) => AgentLaunchEnvironment;
  /** Moves a file or folder to the system Trash. Without one, no skill is removed. */
  trash?: ((file: string) => Promise<void>) | undefined;
  list?: typeof listSkills;
  setEnabled?: typeof setSkillEnabled;
};

/** Which agent's skills, for which conversation or project, as the account that lists them. */
interface SkillsOf {
  agent: HarnessId;
  scope: FileScope;
  claudeAccountId?: string | undefined;
}

/** Where an agent's skills are read: the conversation's folder, and the environment the agent's CLI starts with there. */
interface Context {
  folder: ConversationFolder;
  env: NodeJS.ProcessEnv;
  launch: AgentLaunchEnvironment | null;
}

/** Why a skill can't be changed here, short enough for a badge; null when it can. */
function readOnlyReason(agent: HarnessId, skill: AgentSkill, folder: ConversationFolder): string | null {
  if (skill.source === "project" && folder.readOnly) return "In a read-only copy of the project";
  if (skill.editable) return null;
  if (skill.source === "system") return `Built into ${harnessName(agent)}`;
  if (skill.source === "plugin") return "From a plugin";
  if (/^https?:\/\//.test(skill.path)) return "From a skills catalog";
  return "Synced from claude.ai";
}

/** Where an agent's skills are read for a conversation; Claude's as the account's CLI starts, or its folders without one. */
async function skillContext({ db, claudeEnvironment, claudeLaunch }: Pick<Dependencies, "db" | "claudeEnvironment" | "claudeLaunch">, { agent, scope, claudeAccountId }: SkillsOf): Promise<Context> {
  const folder = await conversationFolder(db, scope);
  if (agent !== "claude") return { folder, env: process.env, launch: null };
  const launch = claudeLaunch
    ? await Promise.resolve()
        .then(() => claudeLaunch(claudeAccountId))
        .catch(() => null)
    : null;
  return { folder, env: launch?.env ?? claudeEnvironment?.(claudeAccountId) ?? process.env, launch };
}

/** A new skill's path as its agent lists it, found by its folder; its own SKILL.md when the agent lists it otherwise, or can't list. */
async function listedPath(skills: Promise<AgentSkill[]>, folder: string): Promise<string> {
  const real = await realpath(folder);
  for (const skill of await skills.catch(() => [])) {
    const at = skillFolderOf(skill.path);
    if (at && (await realpath(at).catch(() => null)) === real) return skill.path;
  }
  return path.join(folder, "SKILL.md");
}

export function createSkillsHandlers({ db, files, claudeEnvironment, claudeLaunch, trash, list = listSkills, setEnabled = setSkillEnabled }: Dependencies): Pick<Handlers, SkillMethod> {
  const context = (ref: SkillsOf) => skillContext({ db, claudeEnvironment, claudeLaunch }, ref);
  /**
   * The agent's skills. Claude Code's own list adds only skills with no file to Claude's folders, so `filed` reads the
   * folders alone, which find every skill a path can name without starting the CLI.
   */
  const listed = ({ folder, env, launch }: Context, agent: HarnessId, filed = false) => {
    const projectRoot = folder.root;
    if (agent !== "claude") return list({ projectRoot, agent });
    return list({ projectRoot, agent, env, ...(launch && !filed ? { launch } : {}) });
  };

  /** The skill as a fresh listing gives it, so a path alone opens nothing the agent doesn't list. */
  const resolve = async (ref: SkillsOf & { skill: string }) => {
    const where = await context(ref);
    const skill = (await listed(where, ref.agent, true)).find((each) => each.path === ref.skill);
    if (!skill) throw new Error("This skill is no longer there. Refresh the list and try again.");
    return { ...where, skill, readOnly: readOnlyReason(ref.agent, skill, where.folder) };
  };

  const editable = async (ref: SkillsOf & { skill: string }) => {
    const found = await resolve(ref);
    if (found.readOnly) throw new Error(`${found.readOnly}, so it can't be changed here.`);
    return found;
  };

  const placeFor = ({ folder, env }: Context, agent: HarnessId, place: "user" | "project") => {
    if (place === "project" && folder.readOnly) throw new Error(folder.readOnly);
    return skillPlace(agent, place, folder.root, env);
  };

  // Looked up in a fresh context: building an added Claude account's environment links in the CLI login's new personal
  // skills, as the next listing will show them.
  const listedAfter = async (ref: SkillsOf, folder: string) => listedPath(listed(await context(ref), ref.agent, true), folder);

  const record = (scope: FileScope, action: string, metadata: Record<string, unknown>) => audit.record(db, { actor: "user", action, resourceType: scope.kind, resourceId: scope.id, metadata });

  return {
    "skills.list": async (ref) => listed(await context(ref), ref.agent),
    "skills.files": async (ref) => listSkillFiles(await skillHome((await resolve(ref)).skill)),
    "skills.readFile": async ({ file, ...ref }) => {
      const { skill, readOnly } = await resolve(ref);
      return readSkillFile(files, await skillHome(skill), file, readOnly);
    },
    "skills.writeFile": async ({ file, text, expected, ...ref }) => {
      const { skill } = await editable(ref);
      const result = await writeSkillFile(files, await skillHome(skill), file, text, expected);
      if (result.kind === "saved") record(ref.scope, "skills.writeFile", { agent: ref.agent, skill: skill.name, file });
      return result;
    },
    "skills.setEnabled": async ({ enabled, ...ref }) => {
      const { skill, folder, env } = await resolve(ref);
      if (skill.enabled === undefined) throw new Error(`${harnessName(ref.agent)} has no switch for this skill.`);
      const now = await setEnabled({ agent: ref.agent, skill, enabled, projectRoot: folder.root, env });
      record(ref.scope, "skills.setEnabled", { agent: ref.agent, skill: skill.name, enabled });
      if (now !== enabled) throw new Error(`This project's ${harnessName(ref.agent)} settings keep this skill ${now ? "on" : "off"}.`);
      return { enabled: now };
    },
    "skills.setIcon": async ({ image, ...ref }) => {
      const { skill } = await editable(ref);
      const home = await skillHome(skill);
      if (home.only !== null) throw new Error("This skill is a single file, with no folder to keep an image in.");
      const icon = await setSkillIcon(files, home.root, image);
      record(ref.scope, "skills.setIcon", { agent: ref.agent, skill: skill.name, icon: icon !== null });
      return { icon };
    },
    "skills.create": async ({ place, name, description, instructions, ...ref }) => {
      const where = await context(ref);
      const folder = await createSkill(placeFor(where, ref.agent, place), name, description, instructions);
      record(ref.scope, "skills.create", { agent: ref.agent, place, skill: name });
      return { skill: await listedAfter(ref, folder) };
    },
    "skills.import": async ({ place, from, ...ref }) => {
      const where = await context(ref);
      const folder = await importSkill(placeFor(where, ref.agent, place), from);
      record(ref.scope, "skills.import", { agent: ref.agent, place, skill: path.basename(folder) });
      return { skill: await listedAfter(ref, folder) };
    },
    "skills.remove": async (ref) => {
      const { skill, env } = await editable(ref);
      if (!trash) throw new Error("There is no Trash to move this skill to here, so it was left in place.");
      const home = await skillHome(skill);
      if (holdsOtherSkills(await listSkillFiles(home))) throw new Error("This skill's folder holds other skills too, so it was left in place.");
      await trash(await removalTarget(ref.agent, skill, env));
      record(ref.scope, "skills.remove", { agent: ref.agent, skill: skill.name });
      return { removed: true };
    },
  };
}

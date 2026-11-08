import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { FileScope, FileVersion } from "./files.js";
import { HarnessId } from "./harness.js";

/** A skill's name as agents call it and as its folder is named: lowercase words joined by hyphens. */
export const SkillName = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);

/**
 * Which skill: the agent, the conversation or project it is listed for, and its `AgentSkill.path` as `skills.list`
 * gave it. Core finds the skill in a fresh listing for the same agent, scope and account, so a path alone opens nothing.
 */
const SkillRef = z.object({ agent: HarnessId, scope: FileScope, skill: z.string().min(1), claudeAccountId: ClaudeAccountId.optional() });

/** A file inside a skill's folder, by its place there: `SKILL.md`, `references/sources.md`. */
const SkillFilePath = z.string().min(1).max(1024);

/** Where a new skill goes: the user's own skills for the agent, or the project's, which the project's people share. */
export const SkillPlace = z.enum(["user", "project"]);
export type SkillPlace = z.infer<typeof SkillPlace>;

/** One entry of a skill's folder. Hidden entries are left out. */
export interface SkillFile {
  path: string;
  kind: "file" | "directory";
}

/** One of a skill's files as it is now: its text, or why it shows no text. `readOnly` says why it can't be edited. */
export type SkillFileRead =
  { kind: "text"; text: string; version: FileVersion; readOnly: string | null } | { kind: "binary"; bytes: number } | { kind: "missing" } | { kind: "unreadable"; reason: string };

/** A save's outcome: the version written, or the file as it is now when it changed since the edit began. */
export type SkillFileWrite = { kind: "saved"; version: FileVersion } | { kind: "conflict"; current: SkillFileRead };

export const skillRpcParams = {
  /** The skill's folder, files and folders alike, in name order. */
  "skills.files": SkillRef,
  "skills.readFile": SkillRef.extend({ file: SkillFilePath }),
  /** Writes a file of a skill the user may edit, only when it is still at `expected`. */
  "skills.writeFile": SkillRef.extend({ file: SkillFilePath, text: z.string().max(2_000_000), expected: FileVersion }),
  /** Turns a skill on or off where its agent keeps that choice. */
  "skills.setEnabled": SkillRef.extend({ enabled: z.boolean() }),
  /** Sets the image of a skill the user may edit, a data URL of a PNG, JPEG, WebP or SVG; null takes it away. */
  "skills.setIcon": SkillRef.extend({ image: z.string().max(2_000_000).nullable() }),
  /** Writes a new skill's folder and SKILL.md for the agent. */
  "skills.create": z.object({
    agent: HarnessId,
    scope: FileScope,
    claudeAccountId: ClaudeAccountId.optional(),
    place: SkillPlace,
    name: SkillName,
    description: z.string().min(1).max(1024),
    instructions: z.string().max(200_000),
  }),
  /** Copies a skill folder the user chose, one holding a SKILL.md, into the agent's skills. */
  "skills.import": z.object({ agent: HarnessId, scope: FileScope, claudeAccountId: ClaudeAccountId.optional(), place: SkillPlace, from: z.string().min(1) }),
  /** Moves a skill the user may edit to the Trash. */
  "skills.remove": SkillRef,
} as const;

export interface SkillRpcResults {
  "skills.files": SkillFile[];
  "skills.readFile": SkillFileRead;
  "skills.writeFile": SkillFileWrite;
  "skills.setEnabled": { enabled: boolean };
  "skills.setIcon": { icon: string | null };
  /** The new skill's SKILL.md, as `skills.list` will give its path. */
  "skills.create": { skill: string };
  "skills.import": { skill: string };
  "skills.remove": { removed: true };
}

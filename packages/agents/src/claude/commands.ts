import type { AgentSkill } from "@openorc/protocol";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { SHARED_CLAUDE_CONFIG_DIR } from "./config-dir.js";
import { withClaudeControlSession } from "./control-session.js";
import { sharedPluginArgs } from "./plugins.js";

/** One of the slash commands Claude Code offers: a built-in, a skill, or a custom or plugin command. */
export interface ClaudeCommand {
  name: string;
  description: string;
  builtin: boolean;
  /** Other names it answers to, as a plugin command's short name. */
  aliases: string[];
}

/** What OpenOrc changes through its own controls, so the picker leaves Claude Code's own commands for them out. */
const OWN_CONTROLS = new Set(["clear", "compact", "effort", "fast", "model"]);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The commands Claude Code offers in `folder`, as its own initialize answer lists them, with no turn and no quota. It
 * starts the way a run does there: the project's settings and the added account's plugins, so the list holds what a
 * conversation can run, disabled plugins and other projects' plugins left out. Internal commands and names with a space,
 * which the CLI reads as a name and an argument, are left out too.
 */
export async function listClaudeCommands(launch: Pick<AgentLaunchEnvironment, "binary" | "env">, folder: string, timeoutMs = 10_000): Promise<ClaudeCommand[]> {
  const args = sharedPluginArgs(launch.env[SHARED_CLAUDE_CONFIG_DIR]);
  return withClaudeControlSession(launch, { task: "listing commands", cwd: folder, settingSources: "all", args, timeoutMs }, async (ask) => {
    const response = await ask({ subtype: "initialize", hooks: {} });
    if (!Array.isArray(response["commands"])) throw new Error("Claude did not list its commands");
    const commands: ClaudeCommand[] = [];
    for (const row of response["commands"] as unknown[]) {
      if (!row || typeof row !== "object") continue;
      const { name, description, builtin, aliases } = row as Record<string, unknown>;
      if (typeof name !== "string" || !name || name.startsWith("__") || /\s/.test(name) || OWN_CONTROLS.has(name)) continue;
      const others = Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string" && alias !== "" && !/\s/.test(alias)) : [];
      commands.push({ name, description: text(description), builtin: builtin === true, aliases: others });
    }
    return commands;
  });
}

/** Where an entry comes from, as Claude Code adds it to the end of the description. */
const ORIGIN = /\s*\((user|project|managed|local|claude\.ai sync)\)\s*$/;
/** A plugin's entries open with the plugin's name, as "(vercel) …". */
const PLUGIN_ORIGIN = /^\((?:[^()]|\([^()]*\))*\)\s*/;

/**
 * Claude Code's list as rows of the skills catalog. What the folders say about an entry, where it lives, whose it is
 * and its description, wins; the rest is read from the list: a built-in, a plugin's by its `plugin:` name, else the
 * project's or the user's as Claude Code marks it.
 */
function listedSource(command: ClaudeCommand): AgentSkill["source"] {
  if (command.builtin) return "system";
  if (command.name.includes(":")) return "plugin";
  return ORIGIN.exec(command.description)?.[1] === "project" ? "project" : "user";
}

export function claudeCommandRows(commands: ClaudeCommand[], read: AgentSkill[]): AgentSkill[] {
  const known = new Map(read.map((skill) => [skill.name, skill]));
  return commands
    .map((command): AgentSkill => {
      const found = known.get(command.name);
      const source = found?.source ?? listedSource(command);
      const unmarked = command.description.replace(ORIGIN, "");
      const listed = (source === "plugin" ? unmarked.replace(PLUGIN_ORIGIN, "") : unmarked).trim();
      return { name: command.name, description: found?.description || listed, source, path: found?.path ?? "", ...(command.aliases.length ? { aliases: command.aliases } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PermissionPreset, RunSpec } from "@openorc/protocol";
import type { AcpProfile, AcpRunContext } from "../acp/profile.js";
import { ompUserServers } from "./connectors.js";
import { ompAgentDir } from "./home.js";

/**
 * Oh My Pi's approval mode for each of OpenOrc's. Reads never ask; Review asks before every edit and command, Accept
 * edits before commands, and Autonomous asks nothing. Plan asks too, and OpenOrc refuses whatever would change files.
 * Asked for, a command comes as a permission request and any other tool as a form; OpenOrc answers both.
 */
const approvalModes: Record<PermissionPreset, string> = { review: "always-ask", trusted: "write", autonomous: "yolo" };

/** A checkout's own files Oh My Pi would run as code even with its extensions off: tools, modules and settings. */
const PROJECT_CODE = [".omp", path.join(".claude", "tools"), path.join(".codex", "tools")];

/**
 * Settings that beat any the project or the user's own configuration set, for OpenOrc's runs only: the approval mode,
 * OpenOrc's tools listed by name rather than mounted as devices, so they show and are approved by their names, and
 * subagents that finish inside the turn, since an ACP client hears nothing between turns.
 */
function overlay(approval: string): string {
  return ["tools:", `  approvalMode: ${approval}`, "  xdev: false", "async:", "  enabled: false", ""].join("\n");
}

/** Oh My Pi's flags for a run; `omp acp` takes the same ones its terminal session does. */
function launchFor(spec: RunSpec, base: NodeJS.ProcessEnv, { host, place }: AcpRunContext) {
  if (spec.untrustedCheckout && (host || PROJECT_CODE.some((name) => existsSync(path.join(spec.cwd, name)))))
    throw new Error("Oh My Pi could load this pull request's own tools and settings, which can run code. Review it with a Claude model instead.");
  const approval = spec.mode === "plan" ? "always-ask" : approvalModes[spec.permissionMode];
  const dir = place.privateDir(spec.runId);
  const config = host ? path.posix.join(dir, "openorc.yml") : path.join(dir, "openorc.yml");
  place.mkdir(dir);
  place.write(config, overlay(approval));
  const args = ["acp", "--approval-mode", approval, "--config", config];
  const env: NodeJS.ProcessEnv = { ...base, PI_NOTIFICATIONS: "off" };
  if (!spec.untrustedCheckout) return { args, env, privateDir: dir };
  // A pull request's own tools and settings are code it brings with it. Its extensions, hooks and language servers
  // are kept off, and the process starts outside it, since Oh My Pi reads the .env of the folder it starts in.
  return { args: [...args, "--no-extensions", "--no-lsp"], env, cwd: dir, privateDir: dir };
}

/** The folder Oh My Pi keeps a session's own files in: beside its session file, named as the file is. */
async function sessionFolder(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const sessions = path.join(ompAgentDir(env["HOME"] || os.homedir(), env), "sessions");
  const suffix = `_${sessionId}.jsonl`;
  for (const project of await readdir(sessions).catch(() => [])) {
    const found = (await readdir(path.join(sessions, project)).catch(() => [])).find((name) => name.endsWith(suffix));
    if (found) return path.join(sessions, project, found.slice(0, -".jsonl".length));
  }
  return null;
}

/** The plan a session proposed: the plan file it changed last among its own `local://` files. */
async function planText(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const folder = await sessionFolder(sessionId, env);
  if (!folder) return null;
  const local = path.join(folder, "local");
  const plans = (await readdir(local).catch(() => [])).filter((name) => name.endsWith("-plan.md") || name === "PLAN.md");
  const dated = await Promise.all(plans.map(async (name) => ({ name, at: (await stat(path.join(local, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = dated.sort((a, b) => b.at - a.at)[0];
  return newest ? readFile(path.join(local, newest.name), "utf8") : null;
}

/** Oh My Pi over ACP: `omp acp`, Plan as its own mode, effort as its thinking level, its forms answered by OpenOrc. */
export const ompAcp: AcpProfile = {
  agent: "omp",
  name: "Oh My Pi",
  effortOption: "thinking",
  elicitation: true,
  launch: launchFor,
  modeValue: (mode) => (mode === "plan" ? "plan" : "default"),
  briefing: () => undefined,
  // Over ACP Oh My Pi reads no MCP configuration of its own, so OpenOrc hands it the servers its terminal sessions use.
  userServers: ompUserServers,
  planText,
};

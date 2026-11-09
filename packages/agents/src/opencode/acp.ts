import { existsSync } from "node:fs";
import path from "node:path";
import type { RunSpec } from "@openorc/protocol";
import type { AgentHost } from "../agent-host.js";
import { planConfig } from "../acp/plan-config.js";
import type { AcpProfile, AcpRunContext } from "../acp/profile.js";
import { questionConfig } from "../acp/questions.js";
import { ownServerConfig } from "../acp/server-config.js";
import { steerOpenCode } from "./steer.js";
import { openCodeOwnTurns } from "./own-turns.js";
import { openCodeSubagentCosts } from "./subagent-cost.js";

/**
 * Whether a folder holds OpenCode settings of its own. OpenCode 2 skips them in an unvetted checkout when told to, but
 * earlier releases load .opencode plugins regardless, so a run there refuses rather than trust the installed version.
 */
function carriesOpenCodeConfig(cwd: string): boolean {
  return ["opencode.json", "opencode.jsonc", ".opencode"].some((name) => existsSync(path.join(cwd, name)));
}

/** A host's folder cannot be looked into from here, so an unvetted checkout there is refused rather than trusted. */
function assertVetted(spec: RunSpec, host: AgentHost | undefined): void {
  if (spec.untrustedCheckout && (host || carriesOpenCodeConfig(spec.cwd)))
    throw new Error("OpenCode could load this pull request's own OpenCode settings and plugins, which can run commands. Review it with a Claude model instead.");
}

/** OpenCode's environment for a run: OpenOrc's tools, its question tool and Plan agent, and nothing from an unvetted checkout. */
function openCodeEnv(base: NodeJS.ProcessEnv, spec: RunSpec, { askUser, mcpUrl, serverName }: AcpRunContext): NodeJS.ProcessEnv {
  const env = { ...base };
  if (mcpUrl) env["OPENCODE_CONFIG_CONTENT"] = ownServerConfig(env["OPENCODE_CONFIG_CONTENT"], serverName, mcpUrl);
  if (askUser) env["OPENCODE_CONFIG_CONTENT"] = questionConfig(env["OPENCODE_CONFIG_CONTENT"]);
  if (spec.mode === "plan") env["OPENCODE_CONFIG_CONTENT"] = planConfig(env["OPENCODE_CONFIG_CONTENT"], spec.internalMcp);
  // A folder's opencode.json and .opencode plugins are code: an unvetted checkout's never load.
  if (spec.untrustedCheckout) env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true";
  return env;
}

/** OpenCode's Plan agent cannot hand its plan over itself, so it saves it with OpenOrc's tool or answers with it. */
function planInstructions(spec: RunSpec, { mcpUrl, serverName }: AcpRunContext): string | undefined {
  if (spec.mode !== "plan") return undefined;
  const delivery = mcpUrl
    ? `Save the complete proposed plan as Markdown with the ${serverName}_plan_write tool; to revise it, call the tool again with the full document. OpenOrc shows it to the user, who implements it from OpenOrc.`
    : "Return the complete proposed plan as Markdown in your final response.";
  return `${delivery} Use read, glob and grep for investigation; shell, edits and native subagents are blocked in Plan.`;
}

/** OpenCode over ACP: `opencode acp`, its Plan and question rules carried in its configuration override. */
export const openCodeAcp: AcpProfile = {
  agent: "opencode",
  name: "OpenCode",
  effortOption: "effort",
  clientMeta: { "opencode/child-session-updates": true },
  elicitation: false,
  ownServerInLaunch: true,
  launch(spec, base, context) {
    assertVetted(spec, context.host);
    return { args: ["acp"], env: openCodeEnv(base, spec, context) };
  },
  modeValue: (mode) => (mode === "plan" ? "plan" : "build"),
  briefing: planInstructions,
  subagentCosts: openCodeSubagentCosts,
  steer: steerOpenCode,
  ownTurns: openCodeOwnTurns,
};

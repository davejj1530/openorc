import type { AcpProfile } from "../acp/profile.js";
import { antigravityOwnTurns } from "./own-turns.js";

/** Antigravity keeps its own Google login, customizations and session store. */
export const antigravityAcp: AcpProfile = {
  agent: "antigravity",
  name: "Antigravity",
  effortOption: "thought_level",
  modelAccount: { id: "antigravity", label: "Google Antigravity account" },
  authMethod: (env) => (env["GEMINI_API_KEY"]?.trim() ? "gemini-api-key" : undefined),
  loadSession: true,
  promptSteering: true,
  compactCommand: null,
  elicitation: true,
  launch(spec, base, context) {
    if (context.host) throw new Error("Antigravity runs on the connected computer. Cloud execution is not supported yet.");
    if (spec.untrustedCheckout) throw new Error("Antigravity can load this checkout's hooks, plugins and MCP servers. Review untrusted checkouts with a Claude model instead.");
    if (spec.forkSession) throw new Error("Antigravity does not support forking conversations through ACP yet. Start a new conversation instead.");
    const args = ["acp", "--process-per-session"];
    if (spec.mode !== "plan") args.push("--dangerously-skip-permissions");
    return { args, env: { ...base } };
  },
  modeValue: (mode) => (mode === "plan" ? "plan" : "default"),
  briefing: () => undefined,
  ownTurns: antigravityOwnTurns,
};

import type { AcpProfile } from "../acp/profile.js";
import { assertCursorSignedIn } from "./auth.js";

/** Cursor owns its credentials and session store; OpenOrc answers its ACP permissions and questions. */
export const cursorAcp: AcpProfile = {
  agent: "cursor",
  name: "Cursor",
  // Cursor exposes complete model variants, including their reasoning settings, in its model option.
  effortOption: null,
  modelAccount: { id: "cursor", label: "Cursor account" },
  authMethod: "cursor_login",
  loadSession: true,
  compactCommand: null,
  checkReady: assertCursorSignedIn,
  // Some Cursor models omit their native question tool; always provide OpenOrc's MCP question path.
  elicitation: false,
  launch(spec, base, context) {
    if (context.host) throw new Error("Cursor runs on the connected computer. Cloud execution is not supported yet.");
    if (spec.untrustedCheckout) throw new Error("Cursor can load this checkout's settings and MCP servers. Review untrusted checkouts with a Claude model instead.");
    if (spec.forkSession) throw new Error("Cursor does not support forking conversations through ACP yet. Start a new conversation instead.");
    return { args: ["acp"], env: { ...base, NO_OPEN_BROWSER: "1" } };
  },
  modeValue: (mode) => (mode === "plan" ? "plan" : "agent"),
  briefing: () => undefined,
};

import type { AcpProfile } from "../acp/profile.js";
import { assertFxReady } from "./auth.js";
import { z } from "zod";
import { fxPromptOutcome } from "./outcome.js";

const steeringResult = z.object({ fx: z.object({ steering: z.enum(["absorbed", "dropped"]) }) });

export const fxAcp: AcpProfile = {
  agent: "fx",
  name: "fx",
  effortOption: "effort",
  providerOption: "provider",
  loadSession: true,
  modeInLaunch: true,
  sessionMeta: (spec) => ({ fx: { profileMcpServers: !spec.strictMcp } }),
  promptSteering: true,
  steeringMeta: { fx: { steer: true } },
  textOnlySteering: true,
  steeringOutcome(response) {
    const read = steeringResult.safeParse(response._meta);
    return read.success && read.data.fx.steering === "dropped" ? "unavailable" : "accepted";
  },
  compactCommand: null,
  promptOutcome: fxPromptOutcome,
  checkReady: assertFxReady,
  elicitation: false,
  launch(spec, base, context) {
    if (context.host) throw new Error("fx runs on the connected computer. Cloud execution is not supported yet.");
    if (spec.untrustedCheckout) throw new Error("fx can load this checkout's configuration and tools. Review untrusted checkouts with a Claude model instead.");
    if (spec.forkSession) throw new Error("fx does not support forking conversations through ACP. Start a new conversation instead.");
    return { args: ["acp", "--no-ultrafast"], env: { ...base, FX_AUTO_UPGRADE: "0", FX_SOUND: "0", FX_PERMISSION_MODE: { review: "ask", trusted: "auto", autonomous: "yolo" }[spec.permissionMode] } };
  },
  modeValue: (_mode, permission) => ({ review: "ask", trusted: "auto", autonomous: "full-access" })[permission],
  briefing: () => undefined,
};

import { HOSTED_REASONS, type HostedCapabilities, type HostedUnavailableControl, type ThreadSummary } from "@openorc/protocol";
import type { PanelTool } from "./panel-tools.js";

export type HostedControl = HostedUnavailableControl | "changes" | "publishing";

/** Only complete desktop bridges may use a server feature. Unknown or absent features do not enable controls. */
export function hostedControlReason(thread: Pick<ThreadSummary, "owner"> | null | undefined, control: HostedControl, capabilities?: HostedCapabilities, failure?: string | null): string | null {
  if (thread?.owner?.brain !== "hosted") return null;
  if (control !== "changes" && control !== "publishing" && control !== "terminal") return HOSTED_REASONS[control];
  if (thread.owner.reach !== "live") return "OpenOrc Cloud can't be reached.";
  if (failure) return failure;
  if (!capabilities) return "Checking cloud features…";
  const feature = capabilities.features[control];
  if (feature?.available) return null;
  if (feature) return feature.reason;
  if (control === "terminal") return HOSTED_REASONS.terminal;
  return control === "changes" ? "Saved changes aren't available in this cloud thread yet." : "Publishing isn't available in this cloud thread yet.";
}

const panelControls: Partial<Record<PanelTool, HostedControl>> = {
  changes: "changes",
  commits: "publishing",
  file: "fileBrowser",
  plan: "plans",
  tasks: "tasks",
  checkpoints: "checkpoints",
  memory: "memory",
  instructions: "instructions",
  terminal: "terminal",
  orcling: "reactions",
};

/** Commits remains open for publishing even while its history is unavailable. Preview is ordinary browsing. */
export function hostedPanelControl(tool: PanelTool): HostedControl | null {
  return panelControls[tool] ?? null;
}

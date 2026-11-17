import { HOSTED_REASONS, type HostedCapabilities, type HostedUnavailableControl, type ThreadSummary } from "@openorc/protocol";
import type { PanelTool } from "./panel-tools.js";

export type HostedControl = HostedUnavailableControl | "changes" | "publishing";

/** The controls each server answers for itself in its capabilities. The rest are held in the app's own words. */
const SERVED = ["changes", "publishing", "terminal", "personSubthreads", "compact", "fork"] as const satisfies readonly (HostedControl & keyof HostedCapabilities["features"])[];
type ServedControl = (typeof SERVED)[number];
const served = (control: HostedControl): control is ServedControl => (SERVED as readonly HostedControl[]).includes(control);

/** Only complete desktop bridges may use a server feature. Unknown or absent features do not enable controls. */
export function hostedControlReason(thread: Pick<ThreadSummary, "owner"> | null | undefined, control: HostedControl, capabilities?: HostedCapabilities, failure?: string | null): string | null {
  if (thread?.owner?.brain !== "hosted") return null;
  if (!served(control)) return HOSTED_REASONS[control];
  if (thread.owner.reach !== "live") return "OpenOrc Cloud can't be reached.";
  if (failure) return failure;
  if (!capabilities) return "Checking cloud features…";
  const feature = capabilities.features[control];
  if (feature?.available) return null;
  return feature?.reason ?? HOSTED_REASONS[control];
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

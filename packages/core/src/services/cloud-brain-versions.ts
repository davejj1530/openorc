import { signInPrint, type AgentVersions, type BrainControlRequest, type BrainControlResults } from "@openorc/cloud";
import { harnessIds } from "@openorc/protocol";

/**
 * Brings the brain's agent CLIs to this Mac's versions, so a conversation moved either way resumes. Asks only when they
 * changed since the brain last confirmed them (`confirmed`, a print); resolves with the print to keep once the brain has
 * every version this Mac knows, else null, so the next wake asks again.
 */
export async function alignAgentVersions(
  machine: { control(request: Extract<BrainControlRequest, { op: "agent-versions" }>): Promise<BrainControlResults["agent-versions"]> },
  confirmed: string | undefined,
  versions: AgentVersions,
): Promise<string | null> {
  const print = signInPrint(versions);
  if (confirmed === print) return null;
  const { versions: has } = await machine.control({ op: "agent-versions", versions });
  return harnessIds.every((id) => versions[id] === null || has[id] === versions[id]) ? print : null;
}

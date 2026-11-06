import type { CloudBrainSignIns } from "@openorc/protocol";
import type { CloudBrainDeps } from "./cloud-brain-deps.js";
import type { BrainMachineLike } from "./cloud-brain-machine.js";

type Payload = Awaited<ReturnType<NonNullable<CloudBrainDeps["skills"]>>>;

/** The skills to send so the brain keeps what this Mac chose, and the digest it keeps then, null for none. */
export interface SkillsChange {
  kept: string | null;
  payload: Payload;
}

/** What the brain lacks of the skills this Mac chose for cloud sessions; null when it keeps them already, or nothing is chosen anywhere. */
export async function skillsChange(sent: string | null | undefined, mac: CloudBrainDeps["skills"]): Promise<SkillsChange | null> {
  if (!mac) return null;
  const payload = await mac();
  const kept = payload.count ? payload.digest : null;
  return (sent ?? null) === kept ? null : { kept, payload };
}

/** Sends the brain the skills it lacks, if it can take them; what the record keeps once it took them, or null. */
export async function handSkills(machine: BrainMachineLike, sent: string | null | undefined, mac: CloudBrainDeps["skills"]): Promise<{ skills: string | null } | null> {
  const change = machine.sendSkills ? await skillsChange(sent, mac) : null;
  if (!change) return null;
  await machine.sendSkills!(change.payload.bytes, change.payload.digest);
  return { skills: change.kept };
}

/** What Settings shows of the brain's skills; reading this Mac's never fails the view. */
export async function skillsView(sent: string | null | undefined, mac: CloudBrainDeps["skills"]): Promise<NonNullable<CloudBrainSignIns["skills"]>> {
  const change = await skillsChange(sent, mac).catch(() => null);
  return { has: (sent ?? null) !== null, behind: change !== null };
}

import type { ModelExecutionSettings, Orcling, TeamInstance, TeamRevision, Thread } from "@openorc/protocol";
import type { EffortTeam } from "../components/ModelPickerEffort";
import { orclingById } from "./orclings";

export type TeamPolicy = Pick<Thread, "mode" | "permissionMode">;
export type TeamPolicyAcknowledgement = TeamPolicy & Pick<Thread, "updatedAt">;
export interface TeamLeadAcknowledgement {
  configurationVersion: number;
  settings: ModelExecutionSettings;
}

/** An RPC receipt must survive the query refresh it triggers. Millisecond ties
 * need matching values because another cached read can share that timestamp. */
export function effectiveTeamPolicy(cached: TeamPolicyAcknowledgement, acknowledged: TeamPolicyAcknowledgement | null): TeamPolicy {
  const current =
    acknowledged &&
    (cached.updatedAt < acknowledged.updatedAt || (cached.updatedAt === acknowledged.updatedAt && (cached.mode !== acknowledged.mode || cached.permissionMode !== acknowledged.permissionMode)))
      ? acknowledged
      : cached;
  return { mode: current.mode, permissionMode: current.permissionMode };
}

/** Team configuration has a monotonic revision, so a caught-up or newer cache
 * can supersede the last locally acknowledged lead selection. */
export function effectiveTeamLead(
  saved: ModelExecutionSettings,
  instance: Pick<TeamInstance, "leadOverrides" | "configurationVersion">,
  acknowledged: TeamLeadAcknowledgement | null,
): ModelExecutionSettings {
  return acknowledged && instance.configurationVersion < acknowledged.configurationVersion ? acknowledged.settings : { ...saved, ...instance.leadOverrides };
}

/** A team as its lead's effort picker names it. An Orcling lead is named even before Orclings load, so its effort stays its own. */
export function pickerTeam(revision: TeamRevision, orclings: readonly Orcling[]): EffortTeam | undefined {
  const lead = revision.members.find((member) => member.managerKey === null);
  if (!lead) return undefined;
  const team = { name: revision.name, revision: revision.number, leadName: lead.name };
  return lead.orclingId ? { ...team, leadOrcling: orclingById(orclings, lead.orclingId)?.name ?? lead.name } : team;
}

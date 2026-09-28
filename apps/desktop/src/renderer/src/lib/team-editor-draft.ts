import { DEFAULT_TEAM_DISCUSSION, DEFAULT_TEAM_LIMITS, MAX_TEAM_MEMBERS, TeamDraft, defaultHarnessId, isHarnessId, teamDiscussion, type TeamDetail, type TeamMember } from "@openorc/protocol";
import type { ModelChoice } from "../components/ModelPicker";
import { readDraft } from "./drafts";

export type EditorDraft = { draft: TeamDraft; base: TeamDraft; expectedRevisionId: string | null };

export function revisionDraft(detail: TeamDetail): TeamDraft {
  const { name, members, limits } = detail.revision;
  return { name, members, limits, discussion: teamDiscussion(detail.revision) };
}

export function blankTeam(): TeamDraft {
  return { name: "", members: [], limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ...DEFAULT_TEAM_DISCUSSION } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recovery accepts unfinished forms; the save schema validates their content. */
function hasDraftStructure(value: unknown): value is TeamDraft {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.members) || !isRecord(value.limits)) return false;
  const limits = value.limits;
  if (!Object.keys(DEFAULT_TEAM_LIMITS).every((key) => typeof limits[key] === "number" && Number.isFinite(limits[key]))) return false;
  if (
    value.discussion !== undefined &&
    !(isRecord(value.discussion) && typeof value.discussion.ambientRounds === "number" && typeof value.discussion.peerFollowUps === "number" && Array.isArray(value.discussion.mentionOnly))
  )
    return false;
  return value.members.every((member) => {
    if (
      !isRecord(member) ||
      typeof member.key !== "string" ||
      typeof member.name !== "string" ||
      typeof member.responsibility !== "string" ||
      (member.managerKey !== null && typeof member.managerKey !== "string") ||
      !isRecord(member.settings)
    )
      return false;
    const settings = member.settings;
    return isHarnessId(settings.agent) && typeof settings.model === "string" && (settings.effort === null || typeof settings.effort === "string") && typeof settings.fastMode === "boolean";
  });
}

export function editorDraft(key: string, detail: TeamDetail | null): EditorDraft {
  const base = detail ? revisionDraft(detail) : blankTeam();
  const fallback = { draft: base, base, expectedRevisionId: detail?.revision.id ?? null };
  const local = readDraft(key, fallback);
  if (!hasDraftStructure(local.draft) || !hasDraftStructure(local.base) || (local.expectedRevisionId !== null && typeof local.expectedRevisionId !== "string")) return fallback;
  return local;
}

export function hasRevisionConflict(state: EditorDraft, detail: TeamDetail | null, lastSaved: TeamDetail | undefined): boolean {
  return Boolean(detail && state.expectedRevisionId !== detail.revision.id && (!lastSaved || detail.revision.number >= lastSaved.revision.number));
}

export function updateTeamMember(draft: TeamDraft, memberKey: string, update: Partial<TeamMember>): Partial<TeamDraft> {
  return {
    members: draft.members.map((member) => (member.key === memberKey ? { ...member, ...update } : member)),
    ...(update.key !== undefined && update.key !== memberKey && draft.discussion
      ? { discussion: { ...draft.discussion, mentionOnly: draft.discussion.mentionOnly.map((key) => (key === memberKey ? update.key! : key)) } }
      : {}),
  };
}

export function addTeamMember(draft: TeamDraft, choice: ModelChoice | null, key: string): Partial<TeamDraft> | null {
  if (draft.members.length >= MAX_TEAM_MEMBERS) return null;
  const settings: TeamMember["settings"] = {
    agent: isHarnessId(choice?.agent) ? choice.agent : defaultHarnessId,
    model: choice?.model ?? "",
    effort: choice?.effort ?? null,
    fastMode: false,
  };
  let number = draft.members.length + 1;
  while (draft.members.some((member) => member.name.toLowerCase() === `member ${number}`)) number += 1;
  const lead = draft.members.find((member) => member.managerKey === null);
  return { members: [...draft.members, { key, name: draft.members.length === 0 ? "Lead" : `Member ${number}`, responsibility: "", managerKey: lead?.key ?? null, settings }] };
}

export function promoteTeamLead(draft: TeamDraft, memberKey: string): Partial<TeamDraft> {
  return {
    members: draft.members.map((member) => {
      if (member.key === memberKey) return { ...member, managerKey: null };
      if (member.managerKey === null) return { ...member, managerKey: memberKey };
      return member;
    }),
  };
}

export function removeTeamMember(draft: TeamDraft, memberKey: string): Partial<TeamDraft> {
  const removed = draft.members.find((member) => member.key === memberKey);
  if (!removed) return {};
  return {
    members: draft.members.filter((member) => member.key !== memberKey).map((member) => (member.managerKey === memberKey ? { ...member, managerKey: removed.managerKey } : member)),
    ...(draft.discussion ? { discussion: { ...draft.discussion, mentionOnly: draft.discussion.mentionOnly.filter((key) => key !== memberKey) } } : {}),
  };
}

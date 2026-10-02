import { randomUUID } from "node:crypto";
import {
  assignDefaultTeamAvatarIndices,
  DEFAULT_TEAM_AVATAR_POOL_SIZE,
  LeadOverrides,
  TeamDraft,
  TeamDiscussion,
  TeamInstance,
  TeamLimits,
  TeamMemberAvatarChoice,
  type Orcling,
  type TeamDefinition,
  type TeamDetail,
  type TeamMember,
  type TeamMemberAvatar,
  type TeamRevision,
} from "@openorc/protocol";
import type { Db } from "./database.js";
import { orclings } from "./orclings.js";

interface TeamRow {
  id: string;
  project_id: string;
  current_revision_id: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  id: string;
  team_id: string;
  project_id: string;
  number: number;
  name: string;
  limits: string;
  discussion?: string | null;
  orcling_seats?: string | null;
  created_at: number;
}

interface MemberRow {
  member_key: string;
  name: string;
  responsibility: string;
  manager_key: string | null;
  agent: TeamMember["settings"]["agent"];
  model: string;
  effort: string | null;
  fast_mode: number;
}

interface MemberAvatarRow {
  team_id: string;
  member_key: string;
  default_index: number;
  custom_path: string | null;
  updated_at: number;
}

interface InstanceRow {
  id: string;
  thread_id: string;
  team_revision_id: string;
  lead_overrides: string;
  configuration_version: number;
  created_at: number;
}

export interface SaveTeamInput {
  projectId: string;
  teamId?: string;
  expectedRevisionId: string | null;
  draft: TeamDraft;
}

export interface ArchiveTeamInput {
  projectId: string;
  teamId: string;
  expectedRevisionId: string;
  archived: boolean;
}

export interface CreateTeamInstanceInput {
  threadId: string;
  teamRevisionId: string;
  initialLeadOverrides?: TeamInstance["leadOverrides"];
}

function teamFromRow(row: TeamRow): TeamDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    currentRevisionId: row.current_revision_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(db: Db, id: string): TeamRow | undefined {
  return db.stmt("SELECT * FROM orchestration_teams WHERE id = ?").get(id) as unknown as TeamRow | undefined;
}

function detailFromRow(db: Db, row: TeamRow): TeamDetail {
  const revision = orchestration.getRevision(db, row.current_revision_id);
  if (!revision) throw new Error("The team's current revision was not found.");
  return { team: teamFromRow(row), revision };
}

function assertRevision(row: TeamRow, expected: string | null): void {
  if (row.current_revision_id !== expected) throw new Error("This team changed since it was opened. Reload its latest revision before saving.");
}

function memberAvatarFromRow(row: MemberAvatarRow): TeamMemberAvatar {
  return {
    teamId: row.team_id,
    memberKey: row.member_key,
    avatar: row.custom_path === null ? { kind: "default", index: row.default_index } : { kind: "custom", path: row.custom_path },
    updatedAt: row.updated_at,
  };
}

function currentMemberKeys(db: Db, teamId: string): string[] {
  const team = getRow(db, teamId);
  if (!team) throw new Error("Team not found.");
  return (
    db
      .stmt(
        `
    SELECT member_key
    FROM orchestration_team_members
    WHERE revision_id = ?
    ORDER BY position
  `,
      )
      .all(team.current_revision_id) as Array<{ member_key: string }>
  ).map((row) => row.member_key);
}

/** Ensure every current member has a durable allocation without rewriting existing rows. */
function ensureMemberAvatars(db: Db, teamId: string, poolSize: number): TeamMemberAvatar[] {
  return db.transaction(() => {
    const memberKeys = currentMemberKeys(db, teamId);
    const rows = db.stmt("SELECT * FROM orchestration_team_member_avatars WHERE team_id = ?").all(teamId) as unknown as MemberAvatarRow[];
    const byMember = new Map(rows.map((row) => [row.member_key, row]));
    const current = new Set(memberKeys);
    const reserved = rows.filter((row) => current.has(row.member_key)).map((row) => row.default_index);
    const missing = memberKeys.filter((memberKey) => !byMember.has(memberKey));
    const allocated = assignDefaultTeamAvatarIndices(missing, poolSize, reserved);
    const updatedAt = Date.now();
    for (const memberKey of missing) {
      const defaultIndex = allocated.get(memberKey);
      if (defaultIndex === undefined) throw new Error(`Could not allocate an avatar for ${memberKey}.`);
      db.stmt("INSERT INTO orchestration_team_member_avatars (team_id, member_key, default_index, custom_path, updated_at) VALUES (?, ?, ?, NULL, ?)").run(teamId, memberKey, defaultIndex, updatedAt);
      byMember.set(memberKey, { team_id: teamId, member_key: memberKey, default_index: defaultIndex, custom_path: null, updated_at: updatedAt });
    }
    return memberKeys.map((memberKey) => memberAvatarFromRow(byMember.get(memberKey)!));
  });
}

function requireMemberAvatar(db: Db, teamId: string, memberKey: string, poolSize: number): MemberAvatarRow {
  if (!currentMemberKeys(db, teamId).includes(memberKey)) throw new Error("Team member not found in the current revision.");
  ensureMemberAvatars(db, teamId, poolSize);
  const row = db.stmt("SELECT * FROM orchestration_team_member_avatars WHERE team_id = ? AND member_key = ?").get(teamId, memberKey) as unknown as MemberAvatarRow | undefined;
  if (!row) throw new Error("Team member avatar was not allocated.");
  return row;
}

/** Saved configuration and pinned identities. These methods never create work. */
export const orchestration = {
  list(db: Db, projectId: string, includeArchived = false): TeamDetail[] {
    const rows = db
      .stmt(`SELECT * FROM orchestration_teams WHERE project_id = ?${includeArchived ? "" : " AND archived_at IS NULL"} ORDER BY updated_at DESC, id`)
      .all(projectId) as unknown as TeamRow[];
    return rows.map((row) => detailFromRow(db, row));
  },

  get(db: Db, id: string): TeamDetail | null {
    const row = getRow(db, id);
    return row ? detailFromRow(db, row) : null;
  },

  getRevision(db: Db, id: string): TeamRevision | null {
    const row = db.stmt("SELECT * FROM orchestration_team_revisions WHERE id = ? AND sealed = 1").get(id) as unknown as RevisionRow | undefined;
    if (!row) return null;
    const members = db.stmt("SELECT * FROM orchestration_team_members WHERE revision_id = ? ORDER BY position").all(id) as unknown as MemberRow[];
    const seats = orclingSeats(db, row.orcling_seats);
    return {
      id: row.id,
      teamId: row.team_id,
      projectId: row.project_id,
      number: row.number,
      name: row.name,
      limits: TeamLimits.parse(JSON.parse(row.limits)),
      ...(row.discussion ? { discussion: TeamDiscussion.parse(JSON.parse(row.discussion)) } : {}),
      members: members.map((member) => ({
        key: member.member_key,
        responsibility: member.responsibility,
        managerKey: member.manager_key,
        ...seatSettings(member, seats.get(member.member_key)),
      })),
      createdAt: row.created_at,
    };
  },

  /** Reading the roster lazily materializes stable defaults for new members. */
  listMemberAvatars(db: Db, teamId: string, poolSize = DEFAULT_TEAM_AVATAR_POOL_SIZE): TeamMemberAvatar[] {
    return ensureMemberAvatars(db, teamId, poolSize);
  },

  setMemberAvatar(db: Db, input: { teamId: string; memberKey: string; avatar: TeamMemberAvatarChoice }, poolSize = DEFAULT_TEAM_AVATAR_POOL_SIZE): TeamMemberAvatar {
    const avatar = TeamMemberAvatarChoice.parse(input.avatar);
    if (avatar.kind === "default" && avatar.index >= poolSize) throw new Error("The selected default avatar does not exist.");
    return db.transaction(() => {
      const previous = requireMemberAvatar(db, input.teamId, input.memberKey, poolSize);
      const unchanged = avatar.kind === "default" ? previous.custom_path === null && previous.default_index === avatar.index : previous.custom_path === avatar.path;
      if (unchanged) return memberAvatarFromRow(previous);
      const updatedAt = Date.now();
      if (avatar.kind === "default") {
        db.stmt("UPDATE orchestration_team_member_avatars SET default_index = ?, custom_path = NULL, updated_at = ? WHERE team_id = ? AND member_key = ?").run(
          avatar.index,
          updatedAt,
          input.teamId,
          input.memberKey,
        );
      } else {
        db.stmt("UPDATE orchestration_team_member_avatars SET custom_path = ?, updated_at = ? WHERE team_id = ? AND member_key = ?").run(avatar.path, updatedAt, input.teamId, input.memberKey);
      }
      const row = db.stmt("SELECT * FROM orchestration_team_member_avatars WHERE team_id = ? AND member_key = ?").get(input.teamId, input.memberKey) as unknown as MemberAvatarRow;
      return memberAvatarFromRow(row);
    });
  },

  /** Reset removes only the custom layer; the member's durable allocation remains. */
  resetMemberAvatar(db: Db, input: { teamId: string; memberKey: string }, poolSize = DEFAULT_TEAM_AVATAR_POOL_SIZE): TeamMemberAvatar {
    return db.transaction(() => {
      const previous = requireMemberAvatar(db, input.teamId, input.memberKey, poolSize);
      if (previous.custom_path === null) return memberAvatarFromRow(previous);
      const updatedAt = Date.now();
      db.stmt("UPDATE orchestration_team_member_avatars SET custom_path = NULL, updated_at = ? WHERE team_id = ? AND member_key = ?").run(updatedAt, input.teamId, input.memberKey);
      return memberAvatarFromRow({ ...previous, custom_path: null, updated_at: updatedAt });
    });
  },

  save(db: Db, input: SaveTeamInput): TeamDetail {
    if (input.teamId !== undefined && input.teamId.trim().length === 0) throw new Error("Team ID cannot be empty.");
    const draft = TeamDraft.parse(input.draft);
    return db.transaction(() => {
      if (!db.stmt("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new Error("Project not found.");
      const existing = input.teamId !== undefined ? getRow(db, input.teamId) : undefined;
      if (input.teamId !== undefined && (!existing || existing.project_id !== input.projectId)) throw new Error("Team not found in this project.");
      if (existing) {
        assertRevision(existing, input.expectedRevisionId);
        if (existing.archived_at !== null) throw new Error("Restore this archived team before editing it.");
      } else if (input.expectedRevisionId !== null) {
        throw new Error("A new team cannot have an expected revision.");
      }

      const time = Date.now();
      const teamId = existing?.id ?? randomUUID();
      const revisionId = randomUUID();
      const previous = existing ? orchestration.getRevision(db, existing.current_revision_id) : null;
      if (!existing) {
        db.stmt("INSERT INTO orchestration_teams (id, project_id, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(teamId, input.projectId, revisionId, time, time);
      }
      db.stmt("INSERT INTO orchestration_team_revisions (id, team_id, project_id, number, name, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        revisionId,
        teamId,
        input.projectId,
        (previous?.number ?? 0) + 1,
        draft.name,
        JSON.stringify(draft.limits),
        time,
      );
      // Discussion settings are part of the revision when the draft has them; a revision without them reads as the defaults.
      if (draft.discussion) db.stmt("UPDATE orchestration_team_revisions SET discussion = ? WHERE id = ?").run(JSON.stringify(draft.discussion), revisionId);
      for (const [position, member] of draft.members.entries()) {
        db.stmt(
          "INSERT INTO orchestration_team_members (revision_id, member_key, position, name, responsibility, manager_key, agent, model, effort, fast_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          revisionId,
          member.key,
          position,
          member.name,
          member.responsibility,
          member.managerKey,
          member.settings.agent,
          member.settings.model,
          member.settings.effort,
          Number(member.settings.fastMode),
        );
      }
      saveSeats(db, revisionId, draft.members);
      db.stmt("UPDATE orchestration_team_revisions SET sealed = 1 WHERE id = ?").run(revisionId);
      if (existing) {
        const result = db
          .stmt("UPDATE orchestration_teams SET current_revision_id = ?, updated_at = ? WHERE id = ? AND project_id = ? AND current_revision_id = ? AND archived_at IS NULL")
          .run(revisionId, time, teamId, input.projectId, input.expectedRevisionId);
        if (result.changes !== 1) throw new Error("This team changed before its revision could be saved. Reload and try again.");
      }
      return detailFromRow(db, getRow(db, teamId)!);
    });
  },

  archive(db: Db, input: ArchiveTeamInput): TeamDetail {
    return db.transaction(() => {
      const row = getRow(db, input.teamId);
      if (!row || row.project_id !== input.projectId) throw new Error("Team not found in this project.");
      assertRevision(row, input.expectedRevisionId);
      if ((row.archived_at !== null) === input.archived) return detailFromRow(db, row);
      const time = Date.now();
      db.stmt("UPDATE orchestration_teams SET archived_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND current_revision_id = ?").run(
        input.archived ? time : null,
        time,
        input.teamId,
        input.projectId,
        input.expectedRevisionId,
      );
      return detailFromRow(db, getRow(db, input.teamId)!);
    });
  },

  /**
   * Inert persistence foundation, not execution selection. Stored lead overrides
   * do not change the thread's current model settings or admit any provider run.
   * The runtime milestone must apply the effective lead projection atomically
   * with its own admission checks before exposing this through a launch path.
   */
  createInstance(db: Db, input: CreateTeamInstanceInput, internal?: { allowArchived?: boolean }): TeamInstance {
    return db.transaction(() => {
      const thread = db.stmt("SELECT project_id FROM threads WHERE id = ?").get(input.threadId) as { project_id: string } | undefined;
      if (!thread) throw new Error("Thread not found.");
      if (orchestration.getInstance(db, input.threadId)) throw new Error("This thread already has a pinned team instance.");
      const revision = orchestration.getRevision(db, input.teamRevisionId);
      if (!revision || revision.projectId !== thread.project_id) throw new Error("Team revision not found in this thread's project.");
      const team = getRow(db, revision.teamId);
      if (!team || (team.archived_at !== null && !internal?.allowArchived)) throw new Error("An archived team cannot be selected for a new instance.");
      const instance = TeamInstance.parse({
        id: randomUUID(),
        threadId: input.threadId,
        teamRevisionId: revision.id,
        members: revision.members.map((member) => ({ id: randomUUID(), memberKey: member.key })),
        leadOverrides: input.initialLeadOverrides ?? {},
        configurationVersion: 1,
        createdAt: Date.now(),
      });
      db.stmt("INSERT INTO orchestration_team_instances (id, thread_id, project_id, team_revision_id, lead_overrides, configuration_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        instance.id,
        instance.threadId,
        thread.project_id,
        instance.teamRevisionId,
        JSON.stringify(instance.leadOverrides),
        instance.configurationVersion,
        instance.createdAt,
      );
      for (const member of instance.members) {
        db.stmt("INSERT INTO orchestration_instance_members (id, instance_id, team_revision_id, member_key) VALUES (?, ?, ?, ?)").run(
          member.id,
          instance.id,
          instance.teamRevisionId,
          member.memberKey,
        );
      }
      return instance;
    });
  },

  /** Lead overrides apply to future turns; admitted attempts retain their settings. */
  updateLeadOverrides(db: Db, input: { threadId: string; expectedConfigurationVersion: number; leadOverrides: LeadOverrides }): TeamInstance {
    const overrides = LeadOverrides.parse(input.leadOverrides);
    return db.transaction(() => {
      const instance = orchestration.getInstance(db, input.threadId);
      if (!instance) throw new Error("This thread has no saved team.");
      if (instance.configurationVersion !== input.expectedConfigurationVersion) throw new Error("Lead settings changed in another window. Reload and try again.");
      if (instance.leadOverrides.effort === overrides.effort && instance.leadOverrides.fastMode === overrides.fastMode) return instance;
      const changed = db
        .stmt("UPDATE orchestration_team_instances SET lead_overrides = ?, configuration_version = configuration_version + 1 WHERE id = ? AND configuration_version = ?")
        .run(JSON.stringify(overrides), instance.id, input.expectedConfigurationVersion);
      if (changed.changes !== 1) throw new Error("Lead settings changed before they could be saved. Reload and try again.");
      return orchestration.getInstance(db, input.threadId)!;
    });
  },

  getInstance(db: Db, threadId: string): TeamInstance | null {
    const row = db.stmt("SELECT * FROM orchestration_team_instances WHERE thread_id = ?").get(threadId) as unknown as InstanceRow | undefined;
    if (!row) return null;
    const members = db
      .stmt(
        "SELECT i.id, i.member_key FROM orchestration_instance_members i JOIN orchestration_team_members m ON m.revision_id = i.team_revision_id AND m.member_key = i.member_key WHERE i.instance_id = ? ORDER BY m.position",
      )
      .all(row.id) as { id: string; member_key: string }[];
    return {
      id: row.id,
      threadId: row.thread_id,
      teamRevisionId: row.team_revision_id,
      leadOverrides: LeadOverrides.parse(JSON.parse(row.lead_overrides)),
      configurationVersion: row.configuration_version,
      createdAt: row.created_at,
      members: members.map((member) => ({ id: member.id, memberKey: member.member_key })),
    };
  },
};

/** The Orclings in a revision's seats, by member key. A deleted Orcling leaves its seat to the model saved with it. */
function orclingSeats(db: Db, saved: string | null | undefined): Map<string, Orcling> {
  const seats = Object.entries(saved ? (JSON.parse(saved) as Record<string, string>) : {});
  return new Map(
    seats.flatMap(([key, id]) => {
      const orcling = orclings.get(db, id);
      return orcling ? [[key, orcling] as const] : [];
    }),
  );
}

/** An Orcling brings its own name and model to its seat, whatever the team saved when it sat down. */
function seatSettings(member: MemberRow, orcling: Orcling | undefined): Pick<TeamMember, "name" | "settings" | "orclingId"> {
  if (orcling) return { name: orcling.name, settings: { ...orcling.settings }, orclingId: orcling.id };
  return { name: member.name, settings: { agent: member.agent, model: member.model, effort: member.effort, fastMode: Boolean(member.fast_mode) } };
}

/** Records which seats Orclings took, before the revision is sealed. A team without Orclings records nothing. */
function saveSeats(db: Db, revisionId: string, members: readonly TeamMember[]): void {
  const seats = Object.fromEntries(members.flatMap((member) => (member.orclingId ? [[member.key, member.orclingId]] : [])));
  if (Object.keys(seats).length) db.stmt("UPDATE orchestration_team_revisions SET orcling_seats = ? WHERE id = ?").run(JSON.stringify(seats), revisionId);
}

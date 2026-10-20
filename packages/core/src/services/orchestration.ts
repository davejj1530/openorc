import { audit, claudeAccounts, orchestration, projects, type Db } from "@openorc/db";
import {
  DEFAULT_TEAM_LIMITS,
  type ModelExecutionSettings,
  TeamDraft,
  harnessCatalog,
  type ExecutableAgent,
  type ModelOption,
  type RpcParams,
  type TeamDetail,
  type TeamMember,
  type TeamMemberAvatar,
  type TeamPreflight,
} from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { normalizeModelSettings } from "@openorc/protocol";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const MAX_AVATAR_BYTES = 32 * 1024 * 1024;
const avatarExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function editableTeam(detail: TeamDetail): TeamDetail {
  return { ...detail, revision: { ...detail.revision, members: detail.revision.members.map((member) => ({ ...member, settings: normalizeModelSettings(member.settings) })) } };
}

export interface TeamCatalog {
  models(agent: ExecutableAgent, claudeAccountId?: string | null): Promise<ModelOption[]>;
  status(agent: ExecutableAgent, refresh: boolean, claudeAccountId?: string | null): Promise<{ installed: boolean; loggedIn: boolean | null }>;
}

/**
 * Saved team configuration. This module never starts agents or prepares a
 * workspace. Availability is checked separately so a disconnected provider
 * cannot prevent editing a team or silently change its requested settings.
 */
export class OrchestrationService {
  constructor(
    private readonly db: Db,
    private readonly catalog: TeamCatalog,
    private readonly invalidate: (keys: string[]) => void,
    private readonly options?: { dataDir: string },
  ) {}

  private requireProject(projectId: string): void {
    if (!projects.get(this.db, projectId)) throw new Error("Project not found.");
  }

  list(projectId: string, includeArchived = false): TeamDetail[] {
    this.requireProject(projectId);
    return orchestration.list(this.db, projectId, includeArchived).map(editableTeam);
  }

  get(id: string): TeamDetail | null {
    const detail = orchestration.get(this.db, id);
    return detail ? editableTeam(detail) : null;
  }

  save(input: RpcParams<"orchestration.save">): TeamDetail {
    this.requireProject(input.projectId);
    const draft = TeamDraft.parse(input.draft);
    this.requireAccounts(draft);
    const detail = orchestration.save(this.db, { ...input, draft: { ...draft, members: draft.members.map((member) => ({ ...member, settings: normalizeModelSettings(member.settings) })) } });
    audit.record(this.db, {
      actor: "user",
      action: "orchestration.save",
      resourceType: "team",
      resourceId: detail.team.id,
      metadata: { projectId: input.projectId, revisionId: detail.revision.id, revision: detail.revision.number },
    });
    this.changed(detail);
    return detail;
  }

  /** A member's own Claude account must still be connected and switched on. */
  private requireAccounts(draft: TeamDraft): void {
    for (const member of draft.members) {
      if (member.settings.agent !== "claude" || !member.claudeAccountId) continue;
      const account = claudeAccounts.get(this.db, member.claudeAccountId);
      if (!account.enabled) throw new Error(`${member.name} runs on ${account.name}, which is disabled. Choose another account, or enable it in Settings → Connections.`);
    }
  }

  archive(input: RpcParams<"orchestration.archive">): TeamDetail {
    this.requireProject(input.projectId);
    const before = orchestration.get(this.db, input.teamId);
    const detail = orchestration.archive(this.db, input);
    if (before?.team.archivedAt !== detail.team.archivedAt) {
      audit.record(this.db, {
        actor: "user",
        action: input.archived ? "orchestration.archive" : "orchestration.restore",
        resourceType: "team",
        resourceId: detail.team.id,
        metadata: { projectId: input.projectId, revisionId: detail.revision.id },
      });
      this.changed(detail);
    }
    return detail;
  }

  memberAvatars(teamId: string): TeamMemberAvatar[] {
    return orchestration.listMemberAvatars(this.db, teamId).map((avatar) => this.exposeManagedAvatar(avatar));
  }

  async setMemberAvatar(input: RpcParams<"orchestration.avatars.set">): Promise<TeamMemberAvatar> {
    const previous = orchestration.listMemberAvatars(this.db, input.teamId).find((avatar) => avatar.memberKey === input.memberKey);
    let storedPath: string | null = null;
    if (input.avatar.kind === "custom" && this.options) storedPath = await this.copyManagedAvatar(input.avatar.path);
    let avatar: TeamMemberAvatar;
    try {
      avatar = orchestration.setMemberAvatar(this.db, {
        ...input,
        avatar: storedPath === null ? input.avatar : { kind: "custom", path: storedPath },
      });
    } catch (error) {
      if (storedPath !== null) await this.removeManagedAvatar(storedPath);
      throw error;
    }
    if (previous?.avatar.kind === "custom" && previous.avatar.path !== storedPath) await this.removeManagedAvatar(previous.avatar.path);
    audit.record(this.db, {
      actor: "user",
      action: "orchestration.avatar.set",
      resourceType: "team-member",
      resourceId: `${input.teamId}:${input.memberKey}`,
      metadata: { teamId: input.teamId, memberKey: input.memberKey, kind: input.avatar.kind },
    });
    this.invalidate(["orchestration.avatars", `team:${input.teamId}`]);
    return this.exposeManagedAvatar(avatar);
  }

  async resetMemberAvatar(input: RpcParams<"orchestration.avatars.reset">): Promise<TeamMemberAvatar> {
    const previous = orchestration.listMemberAvatars(this.db, input.teamId).find((avatar) => avatar.memberKey === input.memberKey);
    const avatar = orchestration.resetMemberAvatar(this.db, input);
    if (previous?.avatar.kind === "custom") await this.removeManagedAvatar(previous.avatar.path);
    audit.record(this.db, {
      actor: "user",
      action: "orchestration.avatar.reset",
      resourceType: "team-member",
      resourceId: `${input.teamId}:${input.memberKey}`,
      metadata: { teamId: input.teamId, memberKey: input.memberKey },
    });
    this.invalidate(["orchestration.avatars", `team:${input.teamId}`]);
    return this.exposeManagedAvatar(avatar);
  }

  private exposeManagedAvatar(avatar: TeamMemberAvatar): TeamMemberAvatar {
    if (!this.options || avatar.avatar.kind !== "custom" || path.isAbsolute(avatar.avatar.path)) return avatar;
    const managedPath = this.managedAvatarPath(avatar.avatar.path);
    return managedPath ? { ...avatar, avatar: { kind: "custom", path: managedPath } } : avatar;
  }

  private async copyManagedAvatar(sourcePath: string): Promise<string> {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!avatarExtensions.has(extension)) throw new Error("Use a PNG, JPEG, GIF, or WebP avatar.");
    let source;
    try {
      source = await stat(sourcePath);
    } catch {
      throw new Error("The selected avatar could not be read.");
    }
    if (!source.isFile()) throw new Error("The selected avatar is not a file.");
    if (source.size > MAX_AVATAR_BYTES) throw new Error("Avatar images must be 32 MB or smaller.");
    const relativePath = path.join("team-avatars", `${randomUUID()}${extension}`);
    const targetPath = this.managedAvatarPath(relativePath);
    if (!targetPath) throw new Error("The avatar destination is invalid.");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const copied = await stat(targetPath);
    if (!copied.isFile() || copied.size > MAX_AVATAR_BYTES) {
      await rm(targetPath, { force: true });
      throw new Error("Avatar images must be 32 MB or smaller.");
    }
    return relativePath;
  }

  private managedAvatarPath(storedPath: string): string | null {
    if (!this.options) return null;
    const root = path.resolve(this.options.dataDir, "team-avatars");
    const resolved = path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(this.options.dataDir, storedPath);
    return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
  }

  /** Never remove a corrupted path or a managed file another member still references. */
  private async removeManagedAvatar(storedPath: string): Promise<void> {
    const managedPath = this.managedAvatarPath(storedPath);
    if (!managedPath) return;
    const referenced = this.db.stmt("SELECT 1 FROM orchestration_team_member_avatars WHERE custom_path = ? LIMIT 1").get(storedPath);
    if (!referenced) await rm(managedPath, { force: true }).catch(() => undefined);
  }

  private changed({ team }: TeamDetail): void {
    this.invalidate(["orchestration", `orchestration:${team.projectId}`, `team:${team.id}`]);
  }

  /**
   * Local readiness, not a promise of account entitlement or runtime availability.
   * User-requested checks refresh by default; automatic turn checks can reuse recent provider readiness.
   */
  async validateExecution(settings: ModelExecutionSettings, projectId: string, claudeAccountId?: string | null): Promise<void> {
    const input = {
      projectId,
      draft: {
        name: "Execution check",
        limits: DEFAULT_TEAM_LIMITS,
        members: [{ key: "member", name: "Member", managerKey: null, responsibility: "Validate the captured execution settings.", settings }],
      },
    };
    let result = await this.preflight(input, { refresh: false, claudeAccountId });
    if (!result.ready) result = await this.preflight(input, { claudeAccountId });
    if (!result.ready) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
  }

  async preflight(input: RpcParams<"orchestration.preflight">, options: { refresh?: boolean; claudeAccountId?: string | null } = {}): Promise<TeamPreflight> {
    this.requireProject(input.projectId);
    const draft = TeamDraft.parse(input.draft);
    // One probe per provider and Claude account, even when several members use the same model.
    const checks = await Promise.all(probeGroups(draft.members, options.claudeAccountId).map((group) => this.checkGroup(group, options.refresh ?? true)));
    const issues = checks.flat();
    return { ready: issues.length === 0, issues };
  }

  /** One provider on one account: whether it is installed and signed in, and whether its catalog serves each member's choice. */
  private async checkGroup({ agent, claudeAccountId, members }: ProbeGroup, refresh: boolean): Promise<TeamPreflight["issues"]> {
    const providerIssue = (code: TeamPreflight["issues"][number]["code"], message: string) => members.map((member) => ({ memberKey: member.key, code, message }));
    let status: Awaited<ReturnType<TeamCatalog["status"]>>;
    try {
      status = await this.catalog.status(agent, refresh, claudeAccountId);
    } catch {
      return providerIssue("provider_unavailable", "Could not check this provider. Try checking readiness again.");
    }
    const label = harnessCatalog[agent].name;
    if (!status.installed) return providerIssue("provider_unavailable", `${label} is not installed or is unavailable on the app's PATH.`);
    if (status.loggedIn === false) return providerIssue("login_required", `Log in to ${label} to use this agent.`);
    if (status.loggedIn !== true) return providerIssue("login_unknown", `Could not confirm login for ${label}.`);
    let models: ModelOption[];
    try {
      models = await this.catalog.models(agent, claudeAccountId);
    } catch {
      return providerIssue("catalog_unavailable", `Could not load ${label} models. Your saved choices are unchanged.`);
    }
    return members.flatMap((member) => memberIssues(member, models));
  }
}

type ProbeGroup = { agent: ExecutableAgent; claudeAccountId: string | undefined; members: TeamMember[] };

/** Members by provider and, for Claude, by the account each runs on: its own, else the conversation's. */
function probeGroups(members: readonly TeamMember[], conversationAccount: string | null | undefined): ProbeGroup[] {
  const groups = new Map<string, ProbeGroup>();
  for (const member of members) {
    const agent = member.settings.agent;
    const claudeAccountId = agent === "claude" ? (member.claudeAccountId ?? conversationAccount ?? undefined) : undefined;
    const key = `${agent}:${claudeAccountId ?? ""}`;
    const group = groups.get(key) ?? { agent, claudeAccountId, members: [] };
    group.members.push(member);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** What a member's saved model, effort and Fast choice lack in its provider's catalog. */
function memberIssues(member: TeamMember, models: ModelOption[]): TeamPreflight["issues"] {
  const settings = normalizeModelSettings(member.settings);
  const model = models.find((option) => option.agent === settings.agent && option.id === settings.model);
  const issue = (code: TeamPreflight["issues"][number]["code"], message: string) => ({ memberKey: member.key, code, message });
  if (!model || model.unavailable) return [issue("model_unavailable", model?.unavailable ?? `${settings.model} is not available in this provider's model catalog.`)];
  const issues: TeamPreflight["issues"] = [];
  if (settings.effort !== null && !model.efforts.includes(settings.effort)) issues.push(issue("effort_unsupported", `${model.label} does not support the saved effort level (${settings.effort}).`));
  if (settings.fastMode && !model.fastMode?.supported) issues.push(issue("fast_unsupported", model.fastMode?.reason ?? `Fast mode is not available for ${model.label}.`));
  return issues;
}

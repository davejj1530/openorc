import { z } from "zod";
import { HarnessId } from "./harness.js";

/** Only providers with an executable adapter may be saved in a team: exactly the registered harnesses. */
export const ExecutableAgent = HarnessId;
export type ExecutableAgent = HarnessId;

export const ModelExecutionSettings = z
  .object({
    agent: ExecutableAgent,
    model: z.string().trim().min(1).max(200),
    effort: z.string().trim().min(1).max(40).nullable(),
    fastMode: z.boolean(),
  })
  .strict();
export type ModelExecutionSettings = z.infer<typeof ModelExecutionSettings>;

export const LeadOverrides = z
  .object({
    effort: z.string().trim().min(1).max(40).nullable().optional(),
    fastMode: z.boolean().optional(),
  })
  .strict();
export type LeadOverrides = z.infer<typeof LeadOverrides>;

/** Team and Orcling are execution targets, never a provider or a model ID. */
export const ExecutionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), settings: ModelExecutionSettings }).strict(),
  z.object({ kind: z.literal("team"), teamRevisionId: z.string().min(1), initialLeadOverrides: LeadOverrides.optional() }).strict(),
  z.object({ kind: z.literal("orcling"), orclingId: z.string().min(1) }).strict(),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTarget>;

export const MAX_TEAM_MEMBERS = 12;
export const MAX_TEAM_DEPTH = 3;
export const DEFAULT_TEAM_AVATAR_POOL_SIZE = MAX_TEAM_MEMBERS;
export const TEAM_LIMIT_BOUNDS = {
  maxConcurrentAgents: { min: 1, max: MAX_TEAM_MEMBERS },
  maxAssignments: { min: 1, max: 100 },
  maxExecutionMinutes: { min: 1, max: 480 },
  maxAttemptsPerAssignment: { min: 1, max: 5 },
} as const;

export const TeamLimits = z
  .object({
    maxConcurrentAgents: z.number().int().min(1).max(TEAM_LIMIT_BOUNDS.maxConcurrentAgents.max),
    maxAssignments: z.number().int().min(1).max(TEAM_LIMIT_BOUNDS.maxAssignments.max),
    maxExecutionMinutes: z.number().int().min(1).max(TEAM_LIMIT_BOUNDS.maxExecutionMinutes.max),
    maxAttemptsPerAssignment: z.number().int().min(1).max(TEAM_LIMIT_BOUNDS.maxAttemptsPerAssignment.max),
  })
  .strict();
export type TeamLimits = z.infer<typeof TeamLimits>;

/** Conservative initial defaults; roster size does not imply concurrency. */
export const DEFAULT_TEAM_LIMITS: Readonly<TeamLimits> = Object.freeze({
  maxConcurrentAgents: 3,
  maxAssignments: 24,
  maxExecutionMinutes: 60,
  maxAttemptsPerAssignment: 2,
});

/** Human-readable model identity for team transcript bylines. */
export function formatModelEffortLabel(model: string, effort: string | null | undefined): string {
  const modelLabel = model.trim();
  const effortLabel = effort?.trim();
  return effortLabel ? `${modelLabel} - ${effortLabel}` : modelLabel;
}

/**
 * Allocate bundled defaults in roster order without disturbing indices already
 * held by current teammates. New members take the lowest free slot. Once a
 * smaller pool is exhausted, a stable member-key hash chooses the reused slot.
 */
export function assignDefaultTeamAvatarIndices(memberKeys: readonly string[], poolSize: number, reservedIndices: readonly number[] = []): ReadonlyMap<string, number> {
  if (!Number.isSafeInteger(poolSize) || poolSize <= 0) throw new Error("The team avatar pool must contain at least one image.");
  const assigned = new Map<string, number>();
  const used = new Set(reservedIndices.filter((index) => Number.isSafeInteger(index) && index >= 0 && index < poolSize));
  for (const memberKey of memberKeys) {
    if (assigned.has(memberKey)) throw new Error(`Duplicate team member key: ${memberKey}`);
    let avatarIndex = -1;
    for (let index = 0; index < poolSize; index += 1) {
      if (!used.has(index)) {
        avatarIndex = index;
        break;
      }
    }
    if (avatarIndex === -1) {
      // FNV-1a keeps reuse deterministic when every bundled image is held.
      let hash = 0x811c9dc5;
      for (let index = 0; index < memberKey.length; index += 1) {
        hash = Math.imul(hash ^ memberKey.charCodeAt(index), 0x01000193) >>> 0;
      }
      avatarIndex = hash % poolSize;
    }
    assigned.set(memberKey, avatarIndex);
    used.add(avatarIndex);
  }
  return assigned;
}

const MemberKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, underscores or dashes for member keys.");

/**
 * How much a team talks on its own. Members who follow the room assess new
 * messages they were not addressed by and may contribute; each assessment is a
 * model turn, so the defaults are deliberately small.
 */
export const TeamDiscussion = z
  .object({
    /** Ambient assessments each following member may make per human message. */
    ambientRounds: z.number().int().min(0).max(3),
    /** Further assessments a member may make when colleagues contribute to the same human request. */
    peerFollowUps: z.number().int().min(0).max(2),
    /** Members who are woken only when addressed. */
    mentionOnly: z.array(MemberKey).max(MAX_TEAM_MEMBERS),
  })
  .strict();
export type TeamDiscussion = z.infer<typeof TeamDiscussion>;
export const DEFAULT_TEAM_DISCUSSION: Readonly<TeamDiscussion> = Object.freeze({ ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] });
/** A revision saved before discussion settings existed behaves like the defaults. */
export const teamDiscussion = (revision: { discussion?: TeamDiscussion | undefined }): TeamDiscussion => revision.discussion ?? DEFAULT_TEAM_DISCUSSION;
export const TeamMember = z
  .object({
    key: MemberKey,
    name: z.string().trim().min(1, "Give every agent a name.").max(80),
    responsibility: z.string().trim().min(1, "Describe each agent's responsibility.").max(8000),
    managerKey: MemberKey.nullable(),
    settings: ModelExecutionSettings,
    /** An Orcling who takes this seat, bringing its instructions and memory. */
    orclingId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamDraft = z
  .object({
    name: z.string().trim().min(1, "Give the team a name.").max(120),
    members: z.array(TeamMember).min(1).max(MAX_TEAM_MEMBERS),
    limits: TeamLimits,
    /** Absent on older drafts and revisions; read through teamDiscussion(). */
    discussion: TeamDiscussion.optional(),
  })
  .strict()
  .superRefine(({ members, discussion }, ctx) => {
    for (const [index, key] of (discussion?.mentionOnly ?? []).entries())
      if (!members.some((member) => member.key === key)) ctx.addIssue({ code: "custom", message: "Mention-only members must belong to this team.", path: ["discussion", "mentionOnly", index] });
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const byKey = new Map<string, TeamMember>();
    const names = new Set<string>();
    for (const [index, member] of members.entries()) {
      if (byKey.has(member.key)) issue("Each agent needs a distinct member key.", ["members", index, "key"]);
      byKey.set(member.key, member);
      const name = member.name.toLowerCase();
      if (names.has(name)) issue("Give each agent a distinct name so its activity is recognizable.", ["members", index, "name"]);
      names.add(name);
    }
    if (members.filter((member) => member.managerKey === null).length !== 1) {
      issue("Choose exactly one lead agent.", ["members"]);
    }
    for (const [index, member] of members.entries()) {
      const seen = new Set<string>();
      let current: TeamMember | undefined = member;
      let depth = 0;
      while (current) {
        if (seen.has(current.key)) {
          issue("An agent cannot manage itself or form a management cycle.", ["members", index, "managerKey"]);
          break;
        }
        seen.add(current.key);
        depth += 1;
        if (depth > MAX_TEAM_DEPTH) {
          issue(`Teams support at most ${MAX_TEAM_DEPTH} levels: lead, manager and worker.`, ["members", index, "managerKey"]);
          break;
        }
        if (current.managerKey === null) break;
        const manager = byKey.get(current.managerKey);
        if (!manager) {
          issue("Every manager must belong to this team.", ["members", index, "managerKey"]);
          break;
        }
        current = manager;
      }
    }
  });
export type TeamDraft = z.infer<typeof TeamDraft>;

export const TeamDefinition = z.object({
  id: z.string(),
  projectId: z.string(),
  currentRevisionId: z.string(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TeamDefinition = z.infer<typeof TeamDefinition>;

export const TeamRevision = TeamDraft.safeExtend({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  number: z.number().int().positive(),
  createdAt: z.number(),
});
export type TeamRevision = z.infer<typeof TeamRevision>;

export const TeamDetail = z.object({ team: TeamDefinition, revision: TeamRevision });
export type TeamDetail = z.infer<typeof TeamDetail>;

export const TeamInstance = z.object({
  id: z.string(),
  threadId: z.string(),
  teamRevisionId: z.string(),
  members: z.array(z.object({ id: z.string(), memberKey: MemberKey })),
  leadOverrides: LeadOverrides,
  configurationVersion: z.number().int().positive(),
  createdAt: z.number(),
});
export type TeamInstance = z.infer<typeof TeamInstance>;

/** Local capability checks only; provider account entitlement is checked on launch. */
export const TeamPreflight = z.object({
  ready: z.boolean(),
  issues: z.array(
    z.object({
      memberKey: z.string().nullable(),
      code: z.enum(["provider_unavailable", "login_required", "login_unknown", "catalog_unavailable", "model_unavailable", "effort_unsupported", "fast_unsupported"]),
      message: z.string(),
    }),
  ),
});
export type TeamPreflight = z.infer<typeof TeamPreflight>;

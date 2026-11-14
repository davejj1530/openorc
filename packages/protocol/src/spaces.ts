import { z } from "zod";
import type { OrganizationSetupResults } from "./organization-setup.js";
import type { OrganizationInvitationResults } from "./organization-invitations.js";
import type { AccountReach } from "./account.js";

export const SpaceId = z.string().min(1).max(200);
export const OrganizationRole = z.enum(["admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

export const Space = z.discriminatedUnion("kind", [
  z.object({ id: SpaceId, kind: z.literal("personal") }),
  z.object({ id: SpaceId, kind: z.literal("organization"), name: z.string(), logo: z.string().nullable(), memberId: z.string(), role: OrganizationRole, memberCount: z.number().int().nonnegative() }),
]);
export type Space = z.infer<typeof Space>;
export type OrganizationSpace = Extract<Space, { kind: "organization" }>;

export interface OrganizationIdentity {
  id: string;
  name: string;
  logo: string | null;
}
export interface ReceivedInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: number;
  organization: OrganizationIdentity;
  inviter: { name: string | null; email: string | null; image?: string | null };
}

export type SpacesStatus =
  | { state: "unavailable" }
  | { state: "signed-out" }
  | { state: "loading"; error: string | null }
  | {
      state: "ready";
      userId: string;
      apiOrigin: string;
      personalSpaceId: string;
      spaces: Space[];
      create: { allowed: boolean; reason: string | null };
      invitations: ReceivedInvitation[];
      reach: AccountReach;
      heardAt: number;
      error: string | null;
    };

/** A visible project has a stable presentation key; a cloud-only project has no invented local folder. */
export interface SpaceProject {
  key: string;
  name: string;
  repo: string | null;
  localProjectId: string | null;
  hostedProjectId: string | null;
  connected: boolean;
}

export interface OrganizationPerson {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: OrganizationRole;
  plan: "free" | "pro";
  joinedAt: number;
}

export interface OrganizationPeople {
  organization: OrganizationIdentity;
  viewer: { memberId: string; role: OrganizationRole };
  members: OrganizationPerson[];
  total: number;
  adminCount: number;
}

export interface OrganizationMembership {
  memberId: string;
  spaceId: string;
  userId: string;
  role: OrganizationRole;
  joinedAt: number;
}

export interface OrganizationProjectAccess {
  projectId: string;
  everyone: boolean;
  memberIds: string[];
}

export const spacesRpcParams = {
  "spaces.status": z.object({}).strict(),
  "spaces.refresh": z.object({}).strict(),
  "spaces.invitation.accept": z.object({ invitationId: SpaceId }).strict(),
  "spaces.invitation.decline": z.object({ invitationId: SpaceId }).strict(),
  "spaces.projects": z.object({ spaceId: SpaceId }).strict(),
  "organization.people": z.object({ spaceId: SpaceId, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  "organization.leave": z.object({ spaceId: SpaceId }).strict(),
  "organization.delete": z.object({ spaceId: SpaceId, name: z.string().max(1000) }).strict(),
  "organization.member.setRole": z.object({ spaceId: SpaceId, memberId: SpaceId, role: OrganizationRole }).strict(),
  "organization.member.remove": z.object({ spaceId: SpaceId, memberId: SpaceId }).strict(),
  "organization.project.access": z.object({ spaceId: SpaceId, projectId: SpaceId }).strict(),
  "organization.project.setAccess": z.object({ spaceId: SpaceId, projectId: SpaceId, everyone: z.boolean(), memberIds: z.array(SpaceId).refine((ids) => new Set(ids).size === ids.length) }).strict(),
};

export interface SpacesRpcResults extends OrganizationSetupResults, OrganizationInvitationResults {
  "spaces.status": SpacesStatus;
  "spaces.refresh": SpacesStatus;
  "spaces.invitation.accept": { spaceId: string };
  "spaces.invitation.decline": Record<string, never>;
  "spaces.projects": SpaceProject[];
  "organization.people": OrganizationPeople;
  "organization.leave": Record<string, never>;
  "organization.delete": Record<string, never>;
  "organization.member.setRole": OrganizationMembership;
  "organization.member.remove": Record<string, never>;
  "organization.project.access": OrganizationProjectAccess;
  "organization.project.setAccess": OrganizationProjectAccess;
}

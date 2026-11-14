import { z } from "zod";
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
  inviter: { name: string | null; email: string | null };
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

export const spacesRpcParams = {
  "spaces.status": z.object({}).strict(),
  "spaces.projects": z.object({ spaceId: SpaceId }).strict(),
  "organization.people": z.object({ spaceId: SpaceId, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
};

export interface SpacesRpcResults {
  "spaces.status": SpacesStatus;
  "spaces.projects": SpaceProject[];
  "organization.people": OrganizationPeople;
}

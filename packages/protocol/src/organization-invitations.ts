import { z } from "zod";
import { OrganizationRole, SpaceId, type OrganizationRole as Role } from "./spaces.js";

export const InvitationEmail = z.email().max(320);

export interface OrganizationInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: number;
  state: "pending" | "expired";
  url: string;
  delivery: null | { status: "sent" | "logged" | "failed"; reason: string | null; at: number };
  resendAt: number;
}

export type OrganizationInviteResult = { email: string } & (
  { state: "sent"; invitationId: string; invitation: OrganizationInvitation | null; error: string | null } | { state: "already-member" | "already-invited" | "refused"; error: string }
);

export const organizationInvitationParams = {
  "organization.invitations": z.object({ spaceId: SpaceId }).strict(),
  "organization.invite": z.object({ spaceId: SpaceId, emails: z.array(z.string().max(320)).min(1).max(30), role: OrganizationRole }).strict(),
  "organization.invitation.resend": z.object({ spaceId: SpaceId, invitationId: SpaceId }).strict(),
  "organization.invitation.revoke": z.object({ spaceId: SpaceId, invitationId: SpaceId }).strict(),
};

export interface OrganizationInvitationResults {
  "organization.invitations": OrganizationInvitation[];
  "organization.invite": OrganizationInviteResult[];
  "organization.invitation.resend": OrganizationInvitation;
  "organization.invitation.revoke": Record<string, never>;
}

import { z } from "zod";
import { OrganizationPersonSeat } from "@openorc/protocol";
import type { Route } from "./wire.js";
import { wireOrganizationAccess } from "./organization-access-wire.js";
import { wireGithubStatus } from "./wire-github.js";

const id = z.string().min(1);
const iso = z.iso.datetime();
const role = z.enum(["admin", "member"]);
const identity = z.object({
  id,
  name: z.string(),
  logo: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});

export const wireSpaces = z
  .object({
    userId: id,
    personalSpaceId: id,
    spaces: z.array(
      z.discriminatedUnion("kind", [
        z.object({ id, kind: z.literal("personal") }),
        identity.extend({ kind: z.literal("organization"), memberId: id, role, memberCount: z.number().int().nonnegative(), accessMessage: z.string().nullable().optional() }),
      ]),
    ),
    create: z.object({ allowed: z.boolean(), reason: z.string().nullable() }),
    organizationAccess: wireOrganizationAccess.optional(),
  })
  .refine(
    (value) => value.spaces.filter((space) => space.kind === "personal").length === 1 && value.spaces.some((space) => space.kind === "personal" && space.id === value.personalSpaceId),
    "Missing personal space",
  );
export type WireSpaces = z.infer<typeof wireSpaces>;

export const wirePeople = z.object({
  organization: identity,
  viewer: z.object({ memberId: id, role }),
  members: z.array(
    z.object({
      memberId: id,
      userId: id,
      name: z.string(),
      email: z.string(),
      image: z.string().nullable(),
      role,
      plan: z.enum(["free", "pro"]),
      joinedAt: iso,
      seat: OrganizationPersonSeat.nullable().optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
  adminCount: z.number().int().nonnegative(),
});

export const wireReceivedInvitations = z.object({
  invitations: z.array(
    z.object({
      id,
      email: z.string(),
      role,
      expiresAt: iso,
      organization: identity,
      inviter: z.object({ name: z.string().nullable(), email: z.string().nullable(), image: z.string().nullish() }),
      includesSeat: z.boolean().optional(),
    }),
  ),
});

/** Better Auth returns bare records on create, invite and role changes. */
export const wireMembership = z.object({ id, organizationId: id, userId: id, role, createdAt: iso });
export const wireOrganization = identity.extend({
  slug: z.string(),
  createdAt: iso,
  personalOf: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});
export const wireInvitation = z.object({
  id,
  organizationId: id,
  email: z.string(),
  role: role.nullable(),
  status: z.enum(["pending", "accepted", "rejected", "canceled"]),
  expiresAt: iso,
  createdAt: iso,
  inviterId: id,
});

const sentInvitations = z.object({
  invitations: z.array(
    z.object({
      id,
      email: z.string(),
      role,
      expiresAt: iso,
      state: z.enum(["pending", "expired"]),
      url: z.url(),
      delivery: z.object({ status: z.enum(["sent", "logged", "failed"]), reason: z.string().nullable(), at: iso }).nullable(),
      resendAfterMs: z.number().nonnegative(),
      includesSeat: z.boolean().optional(),
    }),
  ),
});

const settings = z.object({ name: z.string(), logo: z.string().nullable(), activityDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]) });
const projectAccess = z.object({ projectId: id, everyone: z.boolean(), memberIds: z.array(id) });
const repositories = z.array(z.object({ installationId: id, repoId: z.number().int().positive(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean() }));
const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
const get = <T>(path: string, reply: z.ZodType<T>): Route<T> => ({ method: "GET", path, reply });
const empty = (method: Route<null>["method"], path: string): Route<null> => ({ method, path, reply: null });
export const SPACE_ROUTES = {
  acceptInvitation: route("POST", "/api/auth/organization/accept-invitation", z.object({ invitation: wireInvitation, member: wireMembership })),
  declineInvitation: route("POST", "/api/auth/organization/reject-invitation", z.object({ invitation: wireInvitation, member: z.null() })),
  sentInvitations: get("/invitations", sentInvitations),
  invite: route("POST", "/api/auth/organization/invite-member", wireInvitation),
  revokeInvitation: route("POST", "/api/auth/organization/cancel-invitation", wireInvitation),
  projectAccess: (projectId: string) => get(`/projects/${encodeURIComponent(projectId)}/access`, projectAccess),
  setProjectAccess: (projectId: string) => route("PUT", `/projects/${encodeURIComponent(projectId)}/access`, projectAccess),
  leaveOrganization: empty("POST", "/organization/leave"),
  deleteOrganization: empty("DELETE", "/settings/organization"),
  setMemberRole: (memberId: string) => route("PATCH", `/organization/members/${encodeURIComponent(memberId)}`, wireMembership),
  removeMember: (memberId: string) => empty("DELETE", `/organization/members/${encodeURIComponent(memberId)}`),
  createOrganization: route("POST", "/api/auth/organization/create", wireOrganization.extend({ members: z.array(wireMembership) })),
  updateOrganization: route("PATCH", "/settings/organization", settings),
  organizationGithub: get("/github", wireGithubStatus),
  organizationRepositories: get("/github/repositories", repositories),
  spaceIndex: get("/spaces", wireSpaces),
  /** The organizations with a note that tags the person unread; a 404 from a server that predates notes. */
  mentions: get("/hosted/mentions", z.object({ spaces: z.array(z.object({ spaceId: z.string() })) })),
  receivedInvitations: get("/invitations/received", wireReceivedInvitations),
  people: (offset = 0, limit = 100) => get(`/organization/people?offset=${offset}&limit=${limit}`, wirePeople),
};

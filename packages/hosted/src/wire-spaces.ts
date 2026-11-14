import { z } from "zod";
import type { Route } from "./wire.js";

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
        identity.extend({ kind: z.literal("organization"), memberId: id, role, memberCount: z.number().int().nonnegative() }),
      ]),
    ),
    create: z.object({ allowed: z.boolean(), reason: z.string().nullable() }),
  })
  .refine(
    (value) => value.spaces.filter((space) => space.kind === "personal").length === 1 && value.spaces.some((space) => space.kind === "personal" && space.id === value.personalSpaceId),
    "Missing personal space",
  );
export type WireSpaces = z.infer<typeof wireSpaces>;

export const wirePeople = z.object({
  organization: identity,
  viewer: z.object({ memberId: id, role }),
  members: z.array(z.object({ memberId: id, userId: id, name: z.string(), email: z.string(), image: z.string().nullable(), role, plan: z.enum(["free", "pro"]), joinedAt: iso })),
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
      inviter: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
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

const get = <T>(path: string, reply: z.ZodType<T>): Route<T> => ({ method: "GET", path, reply });
export const SPACE_ROUTES = {
  spaceIndex: get("/spaces", wireSpaces),
  receivedInvitations: get("/invitations/received", wireReceivedInvitations),
  people: (offset = 0, limit = 100) => get(`/organization/people?offset=${offset}&limit=${limit}`, wirePeople),
};

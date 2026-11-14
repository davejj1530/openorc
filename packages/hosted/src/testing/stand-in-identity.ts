import { userOf, type StandInTeam, type StandInSpaces } from "./stand-in-spaces.js";
import { checkedLogo } from "./stand-in-logo.js";

type Reply = { status: number; body: unknown };
const refused = (message: string, status = 400): Reply => ({ status, body: { message } });

/** A synthetic HTTP boundary with the same create/settings records and refusal words as the service. */
interface IdentityRequest {
  method: string;
  path: string;
  space: string | null;
  who: string;
  body: Record<string, unknown>;
  spaces: StandInSpaces;
  created: Map<string, number>;
  allowed: boolean;
  logoFailure: string | null;
  now(): number;
  tell(who: string, topics: string[], space?: string): void;
}
export async function identityRoute(input: IdentityRequest): Promise<Reply | null> {
  const { method, path, who, spaces } = input;
  if (method === "POST" && path === "/api/auth/organization/create") return createOrganization(input);
  if (path !== "/settings/organization" || !["GET", "PATCH"].includes(method)) return null;
  const space = spaces.resolve(who, input.space);
  if (typeof space !== "string") return space;
  const team = spaces.teams.get(space);
  if (!team) return refused("Your personal space has no name, logo or settings to change.", 409);
  if (spaces.member(space, who)?.role !== "admin") return refused("Only an admin can do that.", 403);
  if (method === "PATCH") {
    const error = await patchIdentity(input, team);
    if (error) return error;
  }
  return { status: 200, body: { name: team.name, logo: team.logo, activityDays: 90 } };
}

function organizationName(value: unknown): string | Reply {
  const name = typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (!name) return refused("Give the organization a name.");
  if (name.length > 80) return refused("Keep the name under 80 characters.");
  if (/\p{Cf}/u.test(name)) return refused("That name has characters that don't show. Type it again.");
  if (/https?:|www\.|\w\.com\b/i.test(name)) return refused("Use a name, not a link or a web address.");
  if (!/[\p{L}\p{N}]/u.test(name)) return refused("Use at least one letter or number.");
  if (/openorc/i.test(name)) return refused("That name is reserved. Use your team's own name.");
  return name;
}

function createOrganization(input: IdentityRequest): Reply {
  const { spaces, created, who, body } = input;
  if (!input.allowed) return refused("Creating organizations isn't available on this server.", 403);
  if ((created.get(who) ?? 0) >= 5) return refused("You've made 5 organizations, the most one person can.", 403);
  const name = organizationName(body["name"]);
  if (typeof name !== "string") return name;
  if (spaces.spacesOf(who).some((space) => space.name.toLowerCase() === name.toLowerCase())) return refused(`You're already in an organization called ${name}.`);
  const id = spaces.addTeam(name, [who]);
  created.set(who, (created.get(who) ?? 0) + 1);
  input.tell(who, ["spaces"]);
  return {
    status: 200,
    body: { id, name, slug: id, createdAt: new Date(input.now()).toISOString(), members: spaces.teams.get(id)!.members.map((member) => ({ ...member, userId: userOf(who), organizationId: id })) },
  };
}
async function patchIdentity(input: IdentityRequest, team: StandInTeam): Promise<Reply | null> {
  const { body } = input;
  let nextName = team.name;
  let nextLogo = team.logo;
  if (body["name"] === undefined && body["logo"] === undefined && body["activityDays"] === undefined) return refused("Say what to change.");
  if (body["name"] !== undefined) {
    const name = organizationName(body["name"]);
    if (typeof name !== "string") return name;
    nextName = name;
  }
  if (body["logo"] !== undefined) {
    if (body["logo"] && input.logoFailure) return refused(input.logoFailure);
    const result = await checkedLogo(body["logo"]);
    if ("error" in result) return refused(result.error);
    nextLogo = result.logo;
  }
  team.name = nextName;
  team.logo = nextLogo;
  for (const member of team.members) input.tell(member.email, ["spaces", "settings", "members"], input.space ?? undefined);
  return null;
}

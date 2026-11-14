import { profileRoute } from "./stand-in-profile.js";
import { identityRoute } from "./stand-in-identity.js";
import { membershipRoute } from "./stand-in-membership.js";
import { projectAccessRoute } from "./stand-in-access.js";
import { StandInInvitations } from "./stand-in-invitations.js";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";
import type { StandInBilling } from "./stand-in-billing.js";

type Reply = { status: number; body: unknown };
interface OrganizationDeps {
  spaces: StandInSpaces;
  creationAllowed: boolean;
  person(email: string): { name: string; image: string | null };
  savePerson(email: string, person: { name: string; image: string | null }): void;
  pro(email: string): boolean;
  organizationAccess?(email: string): StandInBilling["organizationAccess"];
  tell(who: string, topics: string[], space?: string): void;
  accessChanged(space: string): void;
  now(): number;
}

/** Organization reads use membership IDs and explicit targets, matching the HTTP service. */
export class StandInOrganizations {
  logoFailure: string | null = null;
  readonly invitations: StandInInvitations;
  readonly created = new Map<string, number>();
  constructor(private readonly deps: OrganizationDeps) {
    this.invitations = new StandInInvitations(deps);
  }

  get received() {
    return this.invitations.records;
  }

  invite(spaceId: string, email: string, inviter: string, role: "admin" | "member" = "member"): string {
    return this.invitations.seed(spaceId, email, inviter, role);
  }

  async route(request: { method: string; path: string; query: URLSearchParams; space: string | null }, who: string, body: Record<string, unknown> = {}): Promise<Reply | null> {
    if (request.method === "PATCH" && request.path === "/account/profile")
      return profileRoute(body, who, this.deps.person(who), (person) => {
        this.deps.savePerson(who, person);
        this.profileChanged(who);
      });
    const invitation = this.invitations.route({ ...request, who, body });
    if (invitation) return invitation;
    const access = projectAccessRoute({ ...request, who, body, spaces: this.deps.spaces, accessChanged: this.deps.accessChanged, tell: this.deps.tell });
    if (access) return access;
    const membership = membershipRoute({
      ...request,
      who,
      body,
      spaces: this.deps.spaces,
      tell: this.deps.tell,
      accessChanged: this.deps.accessChanged,
      recipients: this.received.filter((invite) => invite.spaceId === request.space).map((invite) => invite.email),
    });
    if (membership) return membership;
    const identity = await identityRoute({
      ...request,
      who,
      body,
      spaces: this.deps.spaces,
      created: this.created,
      allowed: this.deps.creationAllowed,
      logoFailure: this.logoFailure,
      now: this.deps.now,
      tell: this.deps.tell,
    });
    if (identity) return identity;
    if (request.method !== "GET") return null;
    if (request.path === "/spaces") return { status: 200, body: this.index(who) };
    if (request.path === "/invitations/received") return { status: 200, body: { invitations: this.inbox(who) } };
    if (request.path !== "/organization/people") return null;
    const space = this.deps.spaces.resolve(who, request.space);
    if (typeof space !== "string") return space;
    return this.people(space, who, request.query);
  }

  index(who: string) {
    const spaces = this.deps.spaces.spacesOf(who).map((space) => {
      const team = this.deps.spaces.teams.get(space.id);
      const member = this.deps.spaces.member(space.id, who);
      return team && member
        ? { id: space.id, kind: "organization", name: team.name, logo: team.logo, memberId: member.id, role: member.role, memberCount: team.members.length }
        : { id: space.id, kind: "personal" };
    });
    let reason: string | null = null;
    if (!this.deps.creationAllowed) reason = "Creating organizations isn't available on this server.";
    else if ((this.created.get(who) ?? 0) >= 5) reason = "You've made 5 organizations, the most one person can.";
    return {
      userId: userOf(who),
      personalSpaceId: `personal-${who}`,
      spaces: [spaces[0], ...spaces.slice(1).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id))],
      create: { allowed: reason === null, reason },
      ...(this.deps.organizationAccess?.(who) !== undefined && { organizationAccess: this.deps.organizationAccess?.(who) }),
    };
  }

  inbox(who: string) {
    return this.invitations.inbox(who);
  }

  planChanged(who: string): void {
    for (const [id, team] of this.deps.spaces.teams) if (team.members.some((member) => member.email === who)) for (const email of this.deps.spaces.readers(id)) this.deps.tell(email, ["members"], id);
  }

  profileChanged(who: string): void {
    this.deps.tell(who, ["spaces"]);
    for (const [id, team] of this.deps.spaces.teams) {
      if (!team.members.some((member) => member.email === who)) continue;
      for (const email of this.deps.spaces.readers(id)) this.deps.tell(email, ["members", "threads", "chat", "invitations"], id);
    }
    const recipients = new Set(this.received.filter((invite) => invite.inviter === who && invite.status === "pending" && invite.expiresAt > this.deps.now()).map((invite) => invite.email));
    for (const email of recipients) this.deps.tell(email, ["invitations"]);
  }

  people(space: string, who: string, query: URLSearchParams): Reply {
    const team = this.deps.spaces.teams.get(space);
    const viewer = this.deps.spaces.member(space, who);
    if (!team || !viewer) return { status: 409, body: { message: "Your personal space is yours alone, so it has no people to list." } };
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 100);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      return { status: 400, body: { message: "Choose an offset of 0 or more and a limit from 1 to 100." } };
    const members = team.members
      .map((member) => ({
        memberId: member.id,
        userId: userOf(member.email),
        ...this.deps.person(member.email),
        email: member.email,
        role: member.role,
        plan: this.deps.pro(member.email) ? "pro" : "free",
        joinedAt: member.createdAt,
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.memberId.localeCompare(b.memberId));
    return {
      status: 200,
      body: {
        organization: { id: space, name: team.name, logo: team.logo },
        viewer: { memberId: viewer.id, role: viewer.role },
        members: members.slice(offset, offset + limit),
        total: members.length,
        adminCount: members.filter((member) => member.role === "admin").length,
      },
    };
  }
}

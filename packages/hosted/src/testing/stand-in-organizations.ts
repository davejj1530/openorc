import { randomUUID } from "node:crypto";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
interface Received {
  id: string;
  spaceId: string;
  email: string;
  role: "admin" | "member";
  inviter: string;
  expiresAt: number;
}
interface OrganizationDeps {
  spaces: StandInSpaces;
  creationAllowed: boolean;
  person(email: string): { name: string; image: string | null };
  pro(email: string): boolean;
  tell(who: string, topics: string[]): void;
  now(): number;
}

/** Organization reads use membership IDs and explicit targets, matching the HTTP service. */
export class StandInOrganizations {
  readonly received: Received[] = [];
  readonly created = new Map<string, number>();
  constructor(private readonly deps: OrganizationDeps) {}

  invite(spaceId: string, email: string, inviter: string, role: "admin" | "member" = "member"): string {
    const id = randomUUID();
    this.received.push({ id, spaceId, email, inviter, role, expiresAt: this.deps.now() + 7 * 86_400_000 });
    this.deps.tell(email, ["invitations"]);
    return id;
  }

  route(request: { method: string; path: string; query: URLSearchParams; space: string | null }, who: string): Reply | null {
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
    };
  }

  inbox(who: string) {
    return this.received
      .filter((invite) => invite.email === who && invite.expiresAt > this.deps.now() && !this.deps.spaces.member(invite.spaceId, who))
      .flatMap((invite) => {
        const team = this.deps.spaces.teams.get(invite.spaceId);
        return team
          ? [
              {
                id: invite.id,
                email: invite.email,
                role: invite.role,
                expiresAt: new Date(invite.expiresAt).toISOString(),
                organization: { id: invite.spaceId, name: team.name, logo: team.logo },
                inviter: { name: this.deps.person(invite.inviter).name, email: invite.inviter },
              },
            ]
          : [];
      })
      .reverse();
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

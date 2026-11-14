import { randomUUID } from "node:crypto";
import { InvitationEmail, type OrganizationRole } from "@openorc/protocol";
import { userOf, type StandInSpaces } from "./stand-in-spaces.js";

type Reply = { status: number; body: unknown };
type Delivery = { status: "sent" | "logged" | "failed"; reason: string | null; at: number };
interface Invitation {
  id: string;
  spaceId: string;
  email: string;
  inviter: string;
  role: OrganizationRole;
  expiresAt: number;
  createdAt: number;
  status: "pending" | "accepted" | "rejected" | "canceled";
  delivery: Delivery | null;
  sentAt: number;
}
interface Dependencies {
  spaces: StandInSpaces;
  person(email: string): { name: string; image: string | null };
  tell(who: string, topics: string[], space?: string): void;
  now(): number;
}
interface Request {
  method: string;
  path: string;
  space: string | null;
  who: string;
  body: Record<string, unknown>;
}
const DAY = 86_400_000;
const COOLDOWN = 600_000;
const refuse = (status: number, message: string, code?: string): Reply => ({ status, body: { message, ...(code ? { code } : {}) } });
const unavailable = () => refuse(400, "This invitation is no longer available.", "INVITATION_NOT_FOUND");
const bare = (invite: Invitation) => ({
  id: invite.id,
  organizationId: invite.spaceId,
  email: invite.email,
  role: invite.role,
  status: invite.status,
  expiresAt: new Date(invite.expiresAt).toISOString(),
  createdAt: new Date(invite.createdAt).toISOString(),
  inviterId: userOf(invite.inviter),
});

/** Invitation admissions are synchronous, so duplicate, cooldown and allowance checks share one write boundary. */
export class StandInInvitations {
  readonly records: Invitation[] = [];
  readonly delivery = new Map<string, Pick<Delivery, "status" | "reason">>();
  readonly ledger: { spaceId: string; who: string; at: number }[] = [];
  constructor(private readonly deps: Dependencies) {}

  seed(spaceId: string, email: string, inviter: string, role: OrganizationRole = "member"): string {
    const now = this.deps.now();
    const invite: Invitation = { id: randomUUID(), spaceId, email, inviter, role, createdAt: now, expiresAt: now + 7 * DAY, status: "pending", sentAt: now, delivery: null };
    this.records.push(invite);
    this.#tell(invite);
    return invite.id;
  }

  route(input: Request): Reply | null {
    if (input.method === "GET" && input.path === "/invitations") return this.#list(input);
    if (input.method !== "POST") return null;
    if (input.path === "/api/auth/organization/invite-member") return this.#send(input);
    if (input.path === "/api/auth/organization/cancel-invitation") return this.#cancel(input);
    if (input.path === "/api/auth/organization/accept-invitation") return this.#respond(input, true);
    if (input.path === "/api/auth/organization/reject-invitation") return this.#respond(input, false);
    return null;
  }

  inbox(who: string) {
    return this.records
      .filter((invite) => invite.status === "pending" && invite.email === who && invite.expiresAt > this.deps.now() && !this.deps.spaces.member(invite.spaceId, who))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
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
                inviter: { ...this.deps.person(invite.inviter), email: invite.inviter },
              },
            ]
          : [];
      });
  }

  #list(input: Request): Reply {
    const space = this.deps.spaces.resolve(input.who, input.space);
    if (typeof space !== "string") return space;
    const denied = this.#admin(input.who, space);
    if (denied) return denied;
    const now = this.deps.now();
    const invitations = this.records
      .filter((invite) => invite.spaceId === space && invite.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        state: invite.expiresAt > now ? "pending" : "expired",
        url: `https://app.example.com/invite/${invite.id}`,
        delivery: invite.delivery ? { ...invite.delivery, at: new Date(invite.delivery.at).toISOString() } : null,
        resendAfterMs: Math.max(0, invite.sentAt + COOLDOWN - now),
      }));
    return { status: 200, body: { invitations } };
  }

  #send(input: Request): Reply {
    const spaceId = String(input.body["organizationId"] ?? "");
    const denied = this.#admin(input.who, spaceId);
    if (denied) return denied;
    const email = String(input.body["email"] ?? "")
      .trim()
      .toLowerCase();
    const role = input.body["role"];
    if (!InvitationEmail.safeParse(email).success) return refuse(400, "Enter a full email address.");
    if (role !== "admin" && role !== "member") return refuse(400, "Choose Admin or Member.");
    if (this.deps.spaces.member(spaceId, email)) return refuse(400, "That person is already in this organization.", "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION");
    const now = this.deps.now();
    const existing = this.records
      .filter((invite) => invite.spaceId === spaceId && invite.email === email && invite.status === "pending" && (input.body["resend"] === true || invite.expiresAt > now))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
    if (existing && input.body["resend"] !== true) return refuse(400, "That person already has an invitation. You can send it again from People.", "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION");
    const limited = this.#limit(input.who, spaceId, existing, now);
    if (limited) return limited;
    const id = existing?.id ?? this.seed(spaceId, email, input.who, role);
    const invite = this.records.find((invite) => invite.id === id)!;
    invite.expiresAt = now + 7 * DAY;
    invite.sentAt = now;
    invite.delivery = { ...(this.delivery.get(email) ?? { status: "sent", reason: null }), at: now };
    this.ledger.push({ spaceId, who: input.who, at: now });
    this.#tell(invite);
    return { status: 200, body: bare(invite) };
  }

  #limit(who: string, spaceId: string, existing: Invitation | undefined, now: number): Reply | null {
    if (existing && existing.sentAt + COOLDOWN > now) {
      const minutes = Math.ceil((existing.sentAt + COOLDOWN - now) / 60_000);
      return refuse(429, `That invite just went out. Send it again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    if (!existing && this.records.filter((invite) => invite.spaceId === spaceId && invite.status === "pending" && invite.expiresAt > now).length >= 100)
      return refuse(403, "This organization has 100 pending invitations. Revoke one before sending another.", "INVITATION_LIMIT_REACHED");
    const recent = this.ledger.filter((send) => send.at > now - DAY);
    if (recent.filter((send) => send.spaceId === spaceId).length >= 30)
      return refuse(429, `${this.deps.spaces.teams.get(spaceId)!.name} has sent 30 invitations in the past 24 hours. Try again later.`);
    if (recent.filter((send) => send.who === who).length >= 20) return refuse(429, "You've sent 20 invitations in the past 24 hours. Try again later.");
    return null;
  }

  #cancel(input: Request): Reply {
    const invite = this.records.find((invite) => invite.id === input.body["invitationId"]);
    if (!invite) return unavailable();
    const denied = this.#admin(input.who, invite.spaceId);
    if (denied) return denied;
    if (invite.status !== "pending") return unavailable();
    invite.status = "canceled";
    this.#tell(invite);
    return { status: 200, body: bare(invite) };
  }

  #admin(who: string, spaceId: string): Reply | null {
    const space = this.deps.spaces.resolve(who, spaceId);
    if (typeof space !== "string") return space;
    if (!this.deps.spaces.teams.has(space)) return refuse(409, "Your personal space is yours alone, so nobody can be invited to it.");
    return this.deps.spaces.member(space, who)?.role === "admin" ? null : refuse(403, "Only an admin can do that.");
  }

  #respond(input: Request, accepting: boolean): Reply {
    const invite = this.records.find((invite) => invite.id === input.body["invitationId"]);
    const team = invite && this.deps.spaces.teams.get(invite.spaceId);
    if (!invite || !team || invite.status !== "pending" || (accepting && invite.expiresAt <= this.deps.now())) return unavailable();
    if (invite.email !== input.who) return refuse(403, "This invitation is for another email address.", "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION");
    if (!accepting) {
      invite.status = "rejected";
      this.#tell(invite);
      return { status: 200, body: { invitation: bare(invite), member: null } };
    }
    if (this.deps.spaces.member(invite.spaceId, input.who)) return refuse(400, "That person is already in this organization.", "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION");
    if (team.members.length >= 100) return refuse(403, "This organization has reached its limit of 100 people.", "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED");
    const member = { id: randomUUID(), email: input.who, role: invite.role, createdAt: new Date(this.deps.now()).toISOString() };
    team.members.push(member);
    invite.status = "accepted";
    for (const email of this.deps.spaces.readers(invite.spaceId)) this.deps.tell(email, ["members", "invitations", "projects", "threads", "spaces"], invite.spaceId);
    this.deps.tell(input.who, ["spaces", "invitations"]);
    return { status: 200, body: { invitation: bare(invite), member: { id: member.id, organizationId: invite.spaceId, userId: userOf(input.who), role: member.role, createdAt: member.createdAt } } };
  }

  #tell(invite: Invitation): void {
    for (const email of this.deps.spaces.readers(invite.spaceId)) this.deps.tell(email, ["invitations"], invite.spaceId);
    this.deps.tell(invite.email, ["invitations"]);
  }
}

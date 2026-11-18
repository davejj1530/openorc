import type { z } from "zod";
import type { wireOrganizationAccess } from "../organization-access-wire.js";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Access = z.infer<typeof wireOrganizationAccess>;
type Request = { method: string; path: string; space: string | null };
type Reply = { status: number; body: unknown };

/**
 * What a frozen person keeps in an organization: leaving, and for an admin the people, the invitations, the seats and
 * billing, the organization's identity and deleting it.
 */
const RECOVERY: { path: RegExp; methods?: string[]; who: "anyone" | "admin" }[] = [
  { path: /^\/organization\/leave$/, methods: ["POST"], who: "anyone" },
  { path: /^\/hosted\/capabilities$/, methods: ["GET"], who: "anyone" },
  { path: /^\/organization\/people$/, methods: ["GET"], who: "admin" },
  { path: /^\/invitations$/, methods: ["GET"], who: "admin" },
  { path: /^\/organization\/(?:billing(?:\/|$)|seats\/|storage$)/, who: "admin" },
  { path: /^\/settings\/organization$/, methods: ["GET", "DELETE"], who: "admin" },
];
const CONTENT = /^\/(?:projects|hosted|chat|tasks|uploads|github|organization)(?:\/|$)|^\/(?:invitations|settings\/organization)$/;
const INVITE = "/api/auth/organization/invite-member";
const MEMBER = "You need Pro to use this organization. Open Account or ask an admin for a seat.";
const ADMIN = "You need Pro to use this organization. Open Account, or give yourself a seat in Seats.";

/** The server's one gate over an organization's content, worded as the server does. */
export class StandInFrozenGate {
  access: (who: string) => Access | undefined = () => undefined;
  constructor(private readonly spaces: StandInSpaces) {}

  /** The 403 envelope for a route closed to this frozen person, or null. `body` is read only for an invitation. */
  refusal(request: Request, who: string, body: unknown = null): Reply | null {
    const invited = request.method === "POST" && request.path === INVITE ? invitation(body) : null;
    const space = invited ? invited.organizationId : request.space;
    const access = this.access(who);
    const member = space ? this.spaces.member(space, who) : undefined;
    if (access?.state !== "frozen" || !space || !this.spaces.teams.has(space) || !member) return null;
    const admin = member.role === "admin";
    if (invited ? invitationOpen(invited, admin) : routeOpen(request, admin)) return null;
    const message = admin ? ADMIN : MEMBER;
    return { status: 403, body: { statusCode: 403, code: "organization_frozen", message, access: { ...access, message: this.words(space, who) } } };
  }

  /** `accessMessage` of the spaces read: the person's private words for this organization, null while it is open to them. */
  words(spaceId: string, who: string): string | null {
    const access = this.access(who);
    if (access?.state !== "frozen") return null;
    return access.reason === "no_pro" && this.spaces.member(spaceId, who)?.role === "admin" ? ADMIN : access.message;
  }
}

/** A frozen admin may invite only with a seat; sending one again keeps whatever it already holds. A member's request meets the admin check, not this gate. */
const invitationOpen = (invited: { seat: boolean; resend: boolean }, admin: boolean): boolean => !admin || invited.seat || invited.resend;

function routeOpen(request: Request, admin: boolean): boolean {
  if (!CONTENT.test(request.path)) return true;
  const kept = RECOVERY.find((route) => route.path.test(request.path) && (!route.methods || route.methods.includes(request.method)));
  return Boolean(kept && (kept.who === "anyone" || admin));
}

function invitation(body: unknown): { organizationId: string; seat: boolean; resend: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const fields = body as Record<string, unknown>;
  return typeof fields["organizationId"] === "string" ? { organizationId: fields["organizationId"], seat: typeof fields["seatId"] === "string", resend: fields["resend"] === true } : null;
}

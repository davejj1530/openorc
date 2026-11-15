import type { z } from "zod";
import type { wireOrganizationAccess } from "../organization-access-wire.js";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Access = z.infer<typeof wireOrganizationAccess>;
type Request = { method: string; path: string; space: string | null };
type Reply = { status: number; body: unknown };

/** What a frozen person keeps in an organization: leaving, and for an admin the people, invitations, seats and billing. */
const RECOVERY: { path: RegExp; method?: string; who: "anyone" | "admin" }[] = [
  { path: /^\/organization\/leave$/, method: "POST", who: "anyone" },
  { path: /^\/hosted\/capabilities$/, method: "GET", who: "anyone" },
  { path: /^\/organization\/people$/, method: "GET", who: "admin" },
  { path: /^\/invitations$/, method: "GET", who: "admin" },
  { path: /^\/organization\/(?:billing(?:\/|$)|seats\/|storage$)/, who: "admin" },
];
const CONTENT = /^\/(?:projects|hosted|chat|tasks|uploads|github|organization)(?:\/|$)|^\/(?:invitations|settings\/organization)$/;

/** The server's one gate over an organization's content, as the seats contract words its refusal. */
export class StandInFrozenGate {
  access: (who: string) => Access | undefined = () => undefined;
  constructor(private readonly spaces: StandInSpaces) {}

  refusal(request: Request, who: string): Reply | null {
    const access = this.access(who);
    const space = request.space;
    if (access?.state !== "frozen" || !space || !this.spaces.teams.has(space) || !CONTENT.test(request.path)) return null;
    const member = this.spaces.member(space, who);
    if (!member) return null;
    const kept = RECOVERY.find((route) => route.path.test(request.path) && (!route.method || route.method === request.method));
    if (kept && (kept.who === "anyone" || member.role === "admin")) return null;
    return {
      status: 403,
      body: { statusCode: 403, code: "organization_frozen", message: "You need Pro to use this organization. Open Account or ask an admin for a seat.", access },
    };
  }
}

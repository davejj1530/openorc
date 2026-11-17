type Reply = { status: number; body: unknown };
type Route = (body: Record<string, unknown>, token: string | null) => Reply;

interface AccountDeletionDeps {
  /** The address a signed token's session is for, or null. */
  holder(token: string | null): string | null;
  /** Spends the code last mailed to the address when it is right: null then, else the refusal. */
  checkCode(email: string, otp: string): Reply | null;
  /** Each route by method and path, for the sign-in route that mails a code. */
  routes: Record<string, Route>;
  /** Sessions by id, each the address it is for. */
  sessions: Map<string, string>;
  /** What the person pays for, their profile and their sign-ins, each by address. */
  billing: Map<string, { pro?: boolean }>;
  people: Map<string, unknown>;
  signIns: Map<string, unknown>;
}

const UNAUTHORIZED: Reply = { status: 401, body: { message: "Unauthorized", statusCode: 401 } };

/**
 * Deleting an account, as the server answers it once nothing holds it: its own organizations and teams are the
 * server's to work out, so the stand-in has none to name, and the person's sessions all end with the request.
 */
export function accountDeletionRoutes(deps: AccountDeletionDeps): Record<string, Route> {
  return {
    "GET /account/deletion": (_body, token) => {
      const who = deps.holder(token);
      return who ? { status: 200, body: { email: who, deleted: [], left: [], held: [], pro: deps.billing.get(who)?.pro ? "paid" : null } } : UNAUTHORIZED;
    },
    "POST /account/deletion/code": (_body, token) => {
      const who = deps.holder(token);
      if (!who) return UNAUTHORIZED;
      deps.routes["POST /api/auth/email-otp/send-verification-otp"]!({ email: who, type: "sign-in" }, null);
      return { status: 204, body: null };
    },
    "DELETE /account": (body, token) => {
      const who = deps.holder(token);
      if (!who) return UNAUTHORIZED;
      if (
        String(body["email"] ?? "")
          .trim()
          .toLowerCase() !== who
      )
        return { status: 400, body: { statusCode: 400, message: `Type ${who} exactly to delete your account.` } };
      const refused = deps.checkCode(who, String(body["otp"] ?? ""));
      if (refused) return refused;
      for (const [id, email] of deps.sessions) if (email === who) deps.sessions.delete(id);
      for (const kept of [deps.billing, deps.people, deps.signIns]) kept.delete(who);
      return { status: 202, body: null };
    },
  };
}

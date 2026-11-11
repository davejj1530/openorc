/**
 * The server's routes and the shapes it answers, parsed where they enter. Nothing outside the package sees a type from
 * this file: translate.ts turns each into the app's own.
 */
import { z } from "zod";

/** A route with the shape of its answer, so a reply is always parsed where it enters. Null: the body is not read. */
export interface Route<T> {
  method: "GET" | "POST";
  path: string;
  reply: z.ZodType<T> | null;
}

const iso = z.iso.datetime();
const hours = z.object({ grantedSeconds: z.number().int(), usedSeconds: z.number().int(), leftSeconds: z.number().int() });
const paidBy = z.discriminatedUnion("kind", [z.object({ kind: z.literal("self") }), z.object({ kind: z.literal("organization"), organizationId: z.string() })]);

export const wireBilling = z.object({
  pro: z.union([
    z.object({ status: z.literal("free") }),
    z.object({ status: z.literal("pro"), standing: z.literal("live"), renewsAt: iso, paidBy }),
    z.object({ status: z.literal("pro"), standing: z.enum(["ending", "grace"]), until: iso, paidBy }),
  ]),
  period: z.object({ startsAt: iso, endsAt: iso }).nullable(),
  monthly: hours.nullable(),
  packs: z.array(hours.extend({ boughtAt: iso, expiresAt: iso })),
  leftSeconds: z.number().int(),
});
export type WireBilling = z.infer<typeof wireBilling>;

/** The words a refusal carries, from either Better Auth (`{ code, message }`) or the server's own routes (`{ message }`). */
export const wireRefusal = z.object({ message: z.string().min(1) });

/** Signing in answers the session's signed token in this header. The body's `token` is the bare session id, which no route takes. */
export const TOKEN_HEADER = "set-auth-token";

const route = <T = null>(method: Route<T>["method"], path: string, reply: z.ZodType<T> | null): Route<T> => ({ method, path, reply });

/** Every route the app calls, in one list. The stand-in server in testing/ serves exactly these. */
export const ROUTES = {
  sendCode: route("POST", "/api/auth/email-otp/send-verification-otp", null),
  signIn: route("POST", "/api/auth/sign-in/email-otp", null),
  signOut: route("POST", "/api/auth/sign-out", null),
  billing: route("GET", "/billing", wireBilling),
} as const;

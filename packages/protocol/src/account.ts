import { z } from "zod";

/**
 * Every request to the OpenOrc server names the version of these shapes the app reads, so a newer server can tell an
 * app that is too old for it.
 */
export const ACCOUNT_PROTOCOL_HEADER = "x-openorc-protocol";
export const ACCOUNT_PROTOCOL_VERSION = 1;

/** Whether the server can be reached now. While offline, everything else is what it last said. */
export type AccountReach = "live" | "offline";

/** Whether the person is Pro, and the moment that matters: it renews, it ends, or its day of grace runs out. */
export type AccountPlan = { pro: false } | { pro: true; standing: "live" | "ending" | "grace"; at: number };

/** Cloud hours the person can still use. `monthly` is null while this month is not paid for. */
export interface CloudHours {
  leftSeconds: number;
  monthly: { grantedSeconds: number; leftSeconds: number; resetsAt: number } | null;
  packsLeftSeconds: number;
}

/** Everything the app knows about the OpenOrc account, in one answer. Signed out is the whole state of an app with no account. */
export type AccountStatus =
  | {
      state: "signed-out";
      /** A code was sent here and has not been used or timed out. */
      codeSentTo: string | null;
      /** The server ended the session (signed out elsewhere, or expired), as opposed to the person signing out here. */
      ended: boolean;
      error: string | null;
    }
  | {
      state: "signed-in";
      email: string;
      reach: AccountReach;
      plan: AccountPlan;
      /** Null for a person who is not Pro. */
      hours: CloudHours | null;
      error: string | null;
    };

const Email = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const accountRpcParams = {
  "account.status": z.object({}),
  /** Emails a six-digit code. */
  "account.sendCode": z.object({ email: Email }).strict(),
  /** The code signs in; the session's token goes to protected storage and never comes back out of the core. */
  "account.signIn": z
    .object({
      email: Email,
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, "Type the six-digit code from the email."),
    })
    .strict(),
  /** Forgets the session here first, then tells the server. */
  "account.signOut": z.object({}),
};

/** Every call answers the whole status, so a window never reads a stale half. */
export type AccountRpcResults = { [M in keyof typeof accountRpcParams]: AccountStatus };

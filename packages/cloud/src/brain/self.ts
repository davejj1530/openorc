import { APIError, Sandbox as SdkSandbox } from "@vercel/sandbox";
import type { VercelCredentials } from "../vercel-sandbox.js";

/** The brain's handle on its own sandbox, with the connection from its start. */
export interface BrainSelf {
  /**
   * Moves this sandbox's stop to `forMs` from now unless it is later already. `capped` when an extension did not move
   * the stop: the plan's longest session (24 h on Pro, 45 min on Hobby) holds it back.
   */
  extend(forMs: number): Promise<{ expiresAt: number; capped: boolean }>;
  /** Stops this sandbox; its disk becomes a snapshot. Again while stopping changes nothing. */
  stop(): Promise<void>;
}

/** The running session of the brain's own sandbox. Tests pass a stand-in; the brain passes the SDK's. */
export interface BrainSession {
  readonly expiresAt: Date | undefined;
  extendTimeout(duration: number): Promise<void>;
  stop(): Promise<unknown>;
}

export type OpenBrainSession = (connection: VercelCredentials, sandbox: string) => Promise<BrainSession>;

const sdkSession: OpenBrainSession = async ({ token, teamId, projectId }, name) => {
  const sandbox = await SdkSandbox.get({ name, resume: false, token, teamId, projectId });
  // The session's calls, not the sandbox's: those resume a stopped sandbox, and this one stops only when it asked to.
  const session = sandbox.currentSession();
  return {
    get expiresAt() {
      return sandbox.expiresAt;
    },
    extendTimeout: (duration) => session.extendTimeout(duration),
    stop: () => session.stop(),
  };
};

/** Vercel's status and error code for a refused call, or null for anything that is not Vercel's answer. */
function refusal(error: unknown): { status: number; code: unknown } | null {
  if (!(error instanceof APIError)) return null;
  const body: unknown = error.json;
  const inner: unknown = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  return { status: error.response.status, code: typeof inner === "object" && inner !== null && "code" in inner ? inner.code : null };
}

/** Vercel's answers to a call on a session that is stopping or stopped already. */
export function alreadyStopping(error: unknown): boolean {
  const refused = refusal(error);
  return refused !== null && (refused.status === 410 || (refused.status === 422 && (refused.code === "sandbox_stopping" || refused.code === "sandbox_snapshotting")));
}

/** Vercel refuses, rather than shortens, an extension past the plan's longest session ("would exceed maximum execution timeout"). */
function pastLongestSession(error: unknown): boolean {
  const refused = refusal(error);
  return refused !== null && refused.status === 400 && refused.code === "sandbox_timeout_invalid";
}

export function brainSelf(connection: VercelCredentials, sandbox: string, open: OpenBrainSession = sdkSession): BrainSelf {
  let session: Promise<BrainSession> | null = null;
  const current = () =>
    (session ??= open(connection, sandbox).catch((error: unknown) => {
      session = null;
      throw error;
    }));
  return {
    async extend(forMs) {
      const handle = await current();
      const before = handle.expiresAt?.getTime() ?? Date.now();
      const wanted = Date.now() + forMs;
      if (before >= wanted) return { expiresAt: before, capped: false };
      try {
        await handle.extendTimeout(wanted - before);
      } catch (error) {
        if (pastLongestSession(error)) return { expiresAt: before, capped: true };
        throw error;
      }
      const after = handle.expiresAt?.getTime() ?? before;
      return { expiresAt: after, capped: after <= before };
    },
    async stop() {
      try {
        await (await current()).stop();
      } catch (error) {
        if (!alreadyStopping(error)) throw error;
      }
    },
  };
}

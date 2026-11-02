import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import type { Thread } from "./domain.js";

/** What a cloud thread's sandbox is doing before its first turn can start. */
export const CloudStep = z.enum(["sandbox", "code", "setup"]);
export type CloudStep = z.infer<typeof CloudStep>;

/** Where a cloud thread's sandbox stands. `removed`: deleted from Settings; the next message sets up a new one. */
export const CloudThreadState = z.object({
  provider: z.enum(["local", "vercel"]),
  state: z.enum(["preparing", "ready", "failed", "removed"]),
  /** The step running now while preparing. */
  step: CloudStep.nullable(),
  /** Whether preparing includes the project's setup script. */
  setup: z.boolean(),
  error: z.string().nullable(),
});
export type CloudThreadState = z.infer<typeof CloudThreadState>;

/** The steps of a cloud check, in order. */
export const CloudCheckStep = z.enum(["sandbox", "tools", "runner", "relay", "sync", "remove"]);
export type CloudCheckStep = z.infer<typeof CloudCheckStep>;

/** A run of the cloud check: everything a cloud thread needs, tried in a throwaway sandbox. */
export interface CloudCheck {
  provider: "local" | "vercel";
  /** Null while it runs; whether every step passed once it ends. */
  passed: boolean | null;
  steps: {
    step: CloudCheckStep;
    state: "pending" | "running" | "done" | "failed";
    ms: number | null;
    detail: string | null;
    error: string | null;
  }[];
}

/** vCPUs a Vercel sandbox can have; each comes with 2 GB of memory. How many a team may use depends on its plan. */
export const SandboxVcpus = z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]);
export const SANDBOX_VCPUS = SandboxVcpus.options.map((option) => option.value);

/** One of OpenOrc's sandboxes, as Settings lists them. */
export interface CloudSandbox {
  name: string;
  provider: "local" | "vercel";
  /** The conversation it belongs to; null for one no conversation has, such as a check's that was not deleted. */
  thread: { id: string; title: string } | null;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  /** When its running session began; null while it does not run. */
  awakeSince: number | null;
  /** How long it has run, all sessions together, as the service last counted. */
  awakeMs: number;
  vcpus: number | null;
  memoryMb: number | null;
  /** Estimated at the service's list prices; null where nothing is billed. */
  costUsd: number | null;
  /** Its conversation's agent is at work there, so it cannot be removed now. */
  working: boolean;
  createdAt: number;
}

/** A Vercel team cloud threads can run on. */
export interface CloudTeam {
  id: string;
  name: string;
}

/** How one Claude account signs in to its sandboxes. An account with nothing to report has no entry. */
export interface ClaudeCloudAccess {
  /** A token is saved; when it was made or pasted. */
  createdAt: number | null;
  /** `claude setup-token` is waiting for the browser sign-in. */
  creating: boolean;
  /** Why the last attempt to make a token failed. */
  error: string | null;
}

/** What Settings shows about where cloud threads run. Tokens never leave the core. */
export interface CloudStatus {
  /** Null until a Vercel token is saved. */
  vercel: {
    /** Null until a team is chosen. */
    team: CloudTeam | null;
    /** The project on that team the sandboxes belong to. */
    project: string | null;
    /** vCPUs for new sandboxes; null for Vercel's default of 2. */
    vcpus: number | null;
  } | null;
  /** By Claude account id. */
  claude: Record<string, ClaudeCloudAccess>;
  /** The last cloud check since OpenOrc started; null before one ran. */
  check: CloudCheck | null;
  /** Working conversations in a worktree move to the cloud when this Mac goes to sleep. */
  takeover: boolean;
  /** Protected storage could not be read. */
  error: string | null;
}

const Token = z.string().trim().min(8).max(1000);

export const cloudRpcParams = {
  "cloud.status": z.object({}),
  /** Checks the token with Vercel and saves it. With one team, that team is chosen too. */
  "cloud.vercel.connect": z.object({ token: Token }).strict(),
  "cloud.vercel.teams": z.object({}),
  /** Chooses the team, and finds or makes the project its sandboxes belong to. */
  "cloud.vercel.team": z.object({ teamId: z.string().min(1).max(200) }).strict(),
  "cloud.vercel.disconnect": z.object({}),
  "cloud.takeover": z.object({ enabled: z.boolean() }).strict(),
  /** The size of sandboxes made from now on. */
  "cloud.vercel.size": z.object({ vcpus: SandboxVcpus }).strict(),
  /** Runs `claude setup-token` for the account; its browser sign-in finishes it. */
  "cloud.claude.create": z.object({ accountId: ClaudeAccountId }).strict(),
  "cloud.claude.cancel": z.object({ accountId: ClaudeAccountId }).strict(),
  /** A token made elsewhere with `claude setup-token`. */
  "cloud.claude.save": z.object({ accountId: ClaudeAccountId, token: Token }).strict(),
  "cloud.claude.remove": z.object({ accountId: ClaudeAccountId }).strict(),
  /** Starts a cloud check where new cloud threads would run; its progress arrives in `cloud.status`. */
  "cloud.check": z.object({}),
  "cloud.sandboxes": z.object({}),
  /** Moves a conversation from this Mac to a sandbox of its own; its sandbox is set up in the background. */
  "cloud.move": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  /** Deletes a sandbox for good. A conversation's next message sets up a new one from its worktree on the Mac. */
  "cloud.sandboxes.remove": z.object({ name: z.string().min(1).max(200) }).strict(),
};

export interface CloudRpcResults {
  "cloud.status": CloudStatus;
  "cloud.vercel.connect": { status: CloudStatus; teams: CloudTeam[] };
  "cloud.vercel.teams": CloudTeam[];
  "cloud.vercel.team": CloudStatus;
  "cloud.vercel.disconnect": CloudStatus;
  "cloud.vercel.size": CloudStatus;
  "cloud.takeover": CloudStatus;
  "cloud.claude.create": CloudStatus;
  "cloud.claude.cancel": CloudStatus;
  "cloud.claude.save": CloudStatus;
  "cloud.claude.remove": CloudStatus;
  "cloud.check": CloudStatus;
  "cloud.sandboxes": CloudSandbox[];
  "cloud.move": Thread;
  "cloud.sandboxes.remove": CloudSandbox[];
}

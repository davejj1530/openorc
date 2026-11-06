import { z } from "zod";
import { brainSyncRpcParams, type BrainSyncRpcResults } from "./brain-sync.js";
import { ClaudeAccountId } from "./claude-accounts.js";
import { BrainRegion, cloudBrainRpcParams, type CloudBrainRpcResults } from "./cloud-brain.js";
import { cloudSignInRpcParams, OpenCodeProviderId, type CloudSignInRpcResults } from "./cloud-sign-ins.js";
import type { Thread } from "./domain.js";

/** Where a cloud thread's sandbox runs: simulated on this Mac, on Vercel, or on Agent37. */
export const CloudProvider = z.enum(["local", "vercel", "agent37"]);
export type CloudProvider = z.infer<typeof CloudProvider>;

/** A cloud service someone connects, which new cloud threads and the cloud brain run on. */
export const CloudService = z.enum(["vercel", "agent37"]);
export type CloudService = z.infer<typeof CloudService>;

/** What a cloud thread's sandbox is doing before its first turn can start. */
export const CloudStep = z.enum(["sandbox", "code", "setup"]);
export type CloudStep = z.infer<typeof CloudStep>;

/** Where a cloud thread's sandbox stands. `removed`: deleted from Settings; the next message sets up a new one. */
export const CloudThreadState = z.object({
  provider: CloudProvider,
  state: z.enum(["preparing", "ready", "failed", "removed"]),
  /** The step running now while preparing. */
  step: CloudStep.nullable(),
  /** Whether preparing includes the project's setup script. */
  setup: z.boolean(),
  error: z.string().nullable(),
  /** A thread this Mac started on its cloud brain, before the brain has it: the brain waking for it, or being updated first. */
  brain: z.enum(["waking", "updating"]).optional(),
});
export type CloudThreadState = z.infer<typeof CloudThreadState>;

/** The steps of a cloud check, in order. */
export const CloudCheckStep = z.enum(["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"]);
export type CloudCheckStep = z.infer<typeof CloudCheckStep>;

/** A run of the cloud check: everything a cloud thread needs, tried in a throwaway sandbox. */
export interface CloudCheck {
  provider: CloudProvider;
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

/** The sizes an Agent37 instance comes in: vCPUs and GB of memory. */
export const AGENT37_SIZES = [
  { cpu: 2, memory: 4 },
  { cpu: 4, memory: 8 },
  { cpu: 4, memory: 16 },
  { cpu: 4, memory: 32 },
] as const;
export type Agent37Size = (typeof AGENT37_SIZES)[number];
export const Agent37Size = z
  .object({ cpu: z.number().int(), memory: z.number().int() })
  .strict()
  .refine(({ cpu, memory }) => AGENT37_SIZES.some((size) => size.cpu === cpu && size.memory === memory), "Agent37 has no instance of that size.")
  .transform((size) => size as Agent37Size);

/** One of OpenOrc's sandboxes, as Settings lists them. */
export interface CloudSandbox {
  name: string;
  provider: CloudProvider;
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
  /** The cloud brain made it for a thread of its own, and deletes it when asked; absent for this Mac's. */
  brain?: true;
}

/** Whether this Mac offers cloud threads, and where a new one would run: what a phone needs to offer them too. */
export interface CloudOffer {
  offered: boolean;
  /** Null when cloud threads are not offered, or no cloud service is connected to start one on. */
  provider: CloudProvider | null;
  /** The cloud brain this Mac set up, once it has started: Move to cloud hands threads to it. Absent on older Macs. */
  brain?: CloudBrainOffer | null;
}

/** The Mac's cloud brain, named for its windows and phones. */
export interface CloudBrainOffer {
  /** The brain's link key, base64url: the id a phone paired with it saved it under; null until the Mac has learned it. */
  host: string | null;
  /** Each Mac project and the brain's copy of it. */
  projects: { mac: string; cloud: string }[];
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

/** How Codex signs in to cloud sandboxes: a ChatGPT sign-in of its own, separate from this Mac's, or an API key. */
export interface CodexCloudAccess {
  mode: "chatgpt" | "apiKey" | null;
  email: string | null;
  plan: string | null;
  /** When the ChatGPT login was last refreshed. */
  refreshedAt: number | null;
  /** The browser sign-in is open. */
  signingIn: boolean;
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
    /** Where new sandboxes run: the region chosen, else the cloud brain's, else the nearest by this Mac's time zone. */
    region: BrainRegion;
    /** Set when Vercel says the saved token reaches more than the chosen team: the whole account, or other teams too. */
    reachesMore?: true;
  } | null;
  /** Null until an Agent37 key is saved. Absent from older cores. */
  agent37?: {
    /** The size of new instances. */
    size: Agent37Size;
  } | null;
  /** The service new cloud threads and the cloud brain run on, among those connected; null with none. Absent from older cores. */
  service?: CloudService | null;
  /** By Claude account id. */
  claude: Record<string, ClaudeCloudAccess>;
  codex: CodexCloudAccess;
  /** OpenCode's provider keys for the cloud, by provider id, entered for the cloud only; the keys never leave the core. */
  opencode: { providers: string[] };
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
  /** The region of sandboxes made from now on. */
  "cloud.vercel.region": z.object({ region: BrainRegion }).strict(),
  /** Checks the key with Agent37 and saves it. */
  "cloud.agent37.connect": z.object({ key: Token }).strict(),
  "cloud.agent37.disconnect": z.object({}),
  /** The size of instances made from now on. */
  "cloud.agent37.size": z.object({ size: Agent37Size }).strict(),
  /** Which connected service new cloud threads and the cloud brain run on. */
  "cloud.service": z.object({ service: CloudService }).strict(),
  /** Runs `claude setup-token` for the account; its browser sign-in finishes it. */
  "cloud.claude.create": z.object({ accountId: ClaudeAccountId }).strict(),
  "cloud.claude.cancel": z.object({ accountId: ClaudeAccountId }).strict(),
  /** A token made elsewhere with `claude setup-token`. */
  "cloud.claude.save": z.object({ accountId: ClaudeAccountId, token: Token }).strict(),
  "cloud.claude.remove": z.object({ accountId: ClaudeAccountId }).strict(),
  /** Runs `codex login` in a folder of OpenOrc's own; its browser sign-in finishes it. */
  "cloud.codex.signIn": z.object({}),
  "cloud.codex.cancel": z.object({}),
  "cloud.codex.apiKey": z.object({ key: Token }).strict(),
  "cloud.codex.remove": z.object({}),
  /** An API key for one of OpenCode's providers, used only by cloud turns whose model that provider serves. */
  "cloud.opencode.saveKey": z.object({ provider: OpenCodeProviderId, key: Token }).strict(),
  "cloud.opencode.removeKey": z.object({ provider: OpenCodeProviderId }).strict(),
  /** Starts a cloud check where new cloud threads would run; its progress arrives in `cloud.status`. */
  "cloud.check": z.object({}),
  "cloud.sandboxes": z.object({}),
  "cloud.offer": z.object({}),
  /** Moves a conversation from this Mac to the cloud brain when one is set up, else to a sandbox of its own. */
  "cloud.move": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  /** Brings a conversation the cloud brain holds to this Mac; it moves in the background. */
  "cloud.bringToMac": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  /** Calls a move off while it has not settled: the conversation stays where it was. */
  "cloud.keep": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  /** A read-only copy of a cloud conversation's code in a folder on this Mac, kept current while it is open. */
  "cloud.openOnMac": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  "cloud.closeOnMac": z.object({ threadId: z.string().min(1).max(200) }).strict(),
  /** Deletes a sandbox for good. A conversation's next message sets up a new one from its worktree on the Mac. */
  "cloud.sandboxes.remove": z.object({ name: z.string().min(1).max(200) }).strict(),
  ...cloudBrainRpcParams,
  ...cloudSignInRpcParams,
  ...brainSyncRpcParams,
};

export interface CloudRpcResults extends CloudBrainRpcResults, CloudSignInRpcResults, BrainSyncRpcResults {
  "cloud.status": CloudStatus;
  "cloud.bringToMac": null;
  "cloud.keep": null;
  "cloud.openOnMac": null;
  "cloud.closeOnMac": null;
  "cloud.vercel.connect": { status: CloudStatus; teams: CloudTeam[] };
  "cloud.vercel.teams": CloudTeam[];
  "cloud.vercel.team": CloudStatus;
  "cloud.vercel.disconnect": CloudStatus;
  "cloud.vercel.size": CloudStatus;
  "cloud.vercel.region": CloudStatus;
  "cloud.agent37.connect": CloudStatus;
  "cloud.agent37.disconnect": CloudStatus;
  "cloud.agent37.size": CloudStatus;
  "cloud.service": CloudStatus;
  "cloud.takeover": CloudStatus;
  "cloud.claude.create": CloudStatus;
  "cloud.claude.cancel": CloudStatus;
  "cloud.claude.save": CloudStatus;
  "cloud.claude.remove": CloudStatus;
  "cloud.codex.signIn": CloudStatus;
  "cloud.codex.cancel": CloudStatus;
  "cloud.codex.apiKey": CloudStatus;
  "cloud.codex.remove": CloudStatus;
  "cloud.opencode.saveKey": CloudStatus;
  "cloud.opencode.removeKey": CloudStatus;
  "cloud.check": CloudStatus;
  "cloud.sandboxes": CloudSandbox[];
  "cloud.offer": CloudOffer;
  "cloud.move": Thread;
  "cloud.sandboxes.remove": CloudSandbox[];
}

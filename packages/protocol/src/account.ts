import { z } from "zod";
import { openCodeProvider } from "./cloud-sign-ins.js";
import { harnessShortName } from "./harness.js";

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

/**
 * Where the person's cloud threads run: the sandbox service they chose, or none and the server's `fallback`, among the
 * services the server runs threads on, each by the name the server gives it.
 */
export interface AccountSandbox {
  chosen: string | null;
  fallback: string;
  services: { id: string; name: string }[];
}

/** The agents OpenOrc Cloud runs. A turn there runs on the person's own sign-in for its agent. */
export const HOSTED_AGENTS = ["claude", "codex", "opencode"] as const;
export type HostedAgent = (typeof HOSTED_AGENTS)[number];
export const isHostedAgent = (agent: string): agent is HostedAgent => (HOSTED_AGENTS as readonly string[]).includes(agent);

/**
 * One of the person's agent sign-ins on OpenOrc Cloud, never its secret. `provider` names an OpenCode key's provider
 * (and Anthropic or OpenAI for the others). `ended`: the server refused a turn on it as signed out since it was last set.
 */
export interface AccountSignIn {
  agent: HostedAgent;
  provider: string;
  label: string;
  ended: boolean;
}

/**
 * How an agent signs in on OpenOrc Cloud. `token`: this Mac runs `claude setup-token` and hands the token over. `code`:
 * the server starts a device code and Settings shows it. `key`: an API key typed in. Settings draws an agent's row from
 * its ways, never from its name, so every agent goes through the one row.
 */
export type SignInWay = "token" | "code" | "key";
export const SIGN_IN_WAYS: Record<HostedAgent, readonly SignInWay[]> = { claude: ["token", "key"], codex: ["code", "key"], opencode: ["key"] };

/** A sign-in under way for an agent, or the last one that failed, with its words. Never a secret. */
export type SignInWork = { state: "waiting"; way: "token" } | { state: "waiting"; way: "code"; userCode: string; verificationUrl: string; expiresAt: number } | { state: "failed"; error: string };

/**
 * The person's GitHub as OpenOrc Cloud knows it, for their own space: whether the server has a GitHub app at all, the
 * GitHub account they linked (their commits and pull requests carry it), the GitHub accounts the app is installed on,
 * and the repositories those let OpenOrc read, as owner/name.
 */
export interface AccountGithub {
  configured: boolean;
  login: string | null;
  installedOn: string[];
  repositories: string[];
}

/** How a person pays for their own Pro, as the server offers it. */
export const PRO_PERIODS = ["monthly", "yearly"] as const;
export type ProPeriod = (typeof PRO_PERIODS)[number];

/** A page the core opens in the browser to pay: a checkout for Pro or for hours, or the billing portal. Its address never reaches a window. */
const BillingPageInput = z.discriminatedUnion("page", [
  z.object({ page: z.literal("pro"), period: z.enum(PRO_PERIODS) }).strict(),
  z.object({ page: z.literal("hours") }).strict(),
  z.object({ page: z.literal("billing") }).strict(),
]);
export type BillingPage = z.infer<typeof BillingPageInput>;

/** An amount of money in its currency's smallest unit, with the currency's ISO code, as the server prices a purchase. */
export interface Price {
  amount: number;
  currency: string;
}

/**
 * What can be bought and what each costs: Pro by each way of paying, and an hours pack with the hours it gives and the
 * months they keep. A price is null where the server has no single amount for it.
 */
export interface BillingOffers {
  pro: { period: ProPeriod; price: Price | null }[];
  hours: { seconds: number; months: number; price: Price | null };
}

/**
 * A page the app opened to pay, until what it is for lands, the person leaves Settings > Account, or it has been open
 * too long. Meanwhile the account is read every few seconds as well as on the server's word.
 */
export type Paying = { page: BillingPage["page"]; since: number };

/**
 * Signing in to OpenOrc through the browser, under way, or the last one's words when it did not sign in. `page` is the
 * sign-in page's address, which may be shown; nothing secret of the sign-in ever reaches a window.
 */
export type BrowserSignIn = { state: "waiting"; page: string } | { state: "failed"; error: string };

/** A trip through GitHub's pages in the browser, under way, or the last one's words when it did not connect. */
export type GithubWork = { state: "waiting" } | { state: "failed"; error: string };

/**
 * Where a project of this Mac stands on OpenOrc Cloud, by its GitHub repository, which is how the two are matched and
 * never stored. `added`: one of the person's spaces has it as a cloud project. `addable`: GitHub lets OpenOrc read it.
 * `unreadable`: not yet, so GitHub is connected first.
 */
export interface AccountProject {
  projectId: string;
  repo: string;
  cloud: "added" | "addable" | "unreadable";
}

/** Everything the app knows about the OpenOrc account, in one answer. `unavailable`: this build has no account server to sign in to. */
export type AccountStatus =
  | { state: "unavailable" }
  | {
      state: "signed-out";
      /** Signing in through the browser, under way or the last that failed. */
      signingIn: BrowserSignIn | null;
      /** The server ended the session (signed out elsewhere, or expired), as opposed to the person signing out here. */
      ended: boolean;
      error: string | null;
    }
  | {
      state: "signed-in";
      email: string;
      /** The person's name as the server keeps it; null until it first answers. */
      name: string | null;
      /** Their picture as a data URL; null for their initials. */
      image: string | null;
      reach: AccountReach;
      plan: AccountPlan;
      /** Null for a person who is not Pro. */
      hours: CloudHours | null;
      /** Null until the server first answers. */
      sandbox: AccountSandbox | null;
      /** The person's agent sign-ins on OpenOrc Cloud; null until the server first answers. */
      signIns: AccountSignIn[] | null;
      /** By agent: a sign-in being made, or the last that failed. */
      signingIn: Partial<Record<HostedAgent, SignInWork>>;
      /** Null until the server first answers. */
      github: AccountGithub | null;
      /** Connecting GitHub under way, or the last that failed. */
      connectingGithub: GithubWork | null;
      /** This Mac's projects that have a GitHub repository, each with where it stands on OpenOrc Cloud. */
      projects: AccountProject[];
      /** A checkout or the billing portal the app opened and has not seen land yet. */
      paying: Paying | null;
      error: string | null;
    };

const Agent = z.enum(HOSTED_AGENTS);
/** An OpenCode provider as OpenCode names it, as the server takes it. */
const Provider = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Name the provider as OpenCode does, such as anthropic or openrouter.");

/** One call per way; the union is the only place a way's inputs are written down. The secret goes to the server and is kept nowhere here. */
const ConnectSignIn = z.discriminatedUnion("way", [
  /** Runs `claude setup-token` as this Claude account of the Mac's, its default when none is named. */
  z.object({ way: z.literal("token"), agent: z.literal("claude"), claudeAccountId: z.string().min(1).max(100).optional() }).strict(),
  /** Asks the server for a device code, which `account.status` then carries until it connects or runs out. */
  z.object({ way: z.literal("code"), agent: z.literal("codex") }).strict(),
  /** `provider` for OpenCode alone. */
  z.object({ way: z.literal("key"), agent: Agent, provider: Provider.optional(), key: z.string().trim().min(1).max(8192) }).strict(),
]);

export const accountRpcParams = {
  "account.status": z.object({}),
  /**
   * Opens OpenOrc's sign-in page in the browser, which hands back to the app once the person signed in there; the
   * session's token goes to protected storage and never comes back out of the core. Asked again while one waits, it
   * opens the same page again.
   */
  "account.signIn": z.object({}).strict(),
  "account.signIn.cancel": z.object({}).strict(),
  /** Forgets the session here first, then tells the server. */
  "account.signOut": z.object({}),
  /** Chooses the sandbox service the person's cloud threads run on; null goes back to the server's own choice. */
  "account.setSandbox": z.object({ service: z.string().min(1).max(64).nullable() }).strict(),
  "account.signIns.connect": ConnectSignIn,
  /** Calls off a token being made or a code being waited on. */
  "account.signIns.cancel": z.object({ agent: Agent }).strict(),
  "account.signIns.remove": z.object({ agent: Agent, provider: Provider.optional() }).strict(),
  /** Links the person's GitHub account and installs OpenOrc's GitHub app, through as many browser trips as GitHub asks for. */
  "account.github.connect": z.object({}).strict(),
  "account.github.cancel": z.object({}).strict(),
  /** Unlinks the person's GitHub account. What the app reaches on GitHub is changed on GitHub. */
  "account.github.disconnect": z.object({}).strict(),
  /** Adds this Mac project's GitHub repository to the person's space as a cloud project. */
  "account.projects.add": z.object({ projectId: z.string().min(1).max(200) }).strict(),
  /** Opens a checkout or the billing portal in the browser. What was bought arrives by itself in `account.status`. */
  "account.billing.open": BillingPageInput,
  /** The person left the screen they paid from: the app stops watching for the purchase and waits for the server's word. */
  "account.billing.leave": z.object({}).strict(),
  /** What Pro and an hours pack cost, read from the server each time it is asked; null when it can't say. */
  "account.offers": z.object({}).strict(),
};

/** Every call but the offers answers the whole status, so a window never reads a stale half. */
export type AccountRpcResults = { [M in Exclude<keyof typeof accountRpcParams, "account.offers">]: AccountStatus } & { "account.offers": BillingOffers | null };

/**
 * Why a message cannot start a turn on OpenOrc Cloud now: out of reach, or one of the server's refusals, which name
 * the same reasons (`HOSTED_REFUSALS`).
 */
export const HOSTED_REFUSALS = ["not_pro", "no_hours", "awaiting_payment", "no_sign_in", "signed_out"] as const;
export type HostedRefusal = (typeof HOSTED_REFUSALS)[number];
export const isHostedRefusal = (refusal: string): refusal is HostedRefusal => (HOSTED_REFUSALS as readonly string[]).includes(refusal);
export type SendBlockWhy = "offline" | HostedRefusal;

/** The one table of words for a block, shown on the card above the composer, on Send, and on a refused send alike. */
const SEND_BLOCK_WORDS: Record<SendBlockWhy, (agent: string) => string> = {
  offline: () => "OpenOrc Cloud can't be reached.",
  not_pro: () => "OpenOrc Cloud needs Pro.",
  no_hours: () => "You're out of cloud hours.",
  awaiting_payment: () => "Your payment hasn't gone through.",
  no_sign_in: (agent) => `${harnessShortName(agent)} isn't signed in on OpenOrc Cloud.`,
  signed_out: (agent) => `${harnessShortName(agent)}'s sign-in on OpenOrc Cloud ended.`,
};

export const sendBlockWords = (why: SendBlockWhy, agent: string): string => SEND_BLOCK_WORDS[why](agent);

/**
 * The block on starting a turn on OpenOrc Cloud with these settings, from the account as the app last heard it, in the
 * order the server checks: hours first, then the agent's sign-in. Null when a send can go, or when the app cannot tell
 * (signed out, or the sign-ins not heard yet), and for a message into a running turn, which runs on that turn's starter.
 * The server stays the judge: a send this lets through can still be refused, and the account is then read again.
 */
export function hostedSendBlock(account: AccountStatus | undefined, settings: { agent: string; model: string | null }, steering: boolean): SendBlockWhy | null {
  if (account?.state !== "signed-in") return null;
  if (account.reach !== "live") return "offline";
  if (steering) return null;
  const paying = payBlock(account);
  if (paying) return paying;
  if (!account.signIns || !isHostedAgent(settings.agent)) return null;
  const provider = settings.agent === "opencode" ? openCodeProvider(settings.model) : null;
  if (settings.agent === "opencode" && !provider) return null;
  const signIn = account.signIns.find((row) => row.agent === settings.agent && (provider === null || row.provider === provider));
  if (!signIn) return "no_sign_in";
  return signIn.ended ? "signed_out" : null;
}

/** What only paying fixes, in the server's order: not Pro, then no hours left, as this month's or as unpaid. */
export function payBlock(account: Pick<Extract<AccountStatus, { state: "signed-in" }>, "plan" | "hours">): "not_pro" | "no_hours" | "awaiting_payment" | null {
  if (!account.plan.pro) return "not_pro";
  if ((account.hours?.leftSeconds ?? 0) <= 0) return account.hours?.monthly ? "no_hours" : "awaiting_payment";
  return null;
}

import os from "node:os";
import { signInPrint, type BrainControlResults, type BrainHandover, type HandoverCodexLogin, type HandoverValues } from "@openorc/cloud";
import { GitError, git, run } from "@openorc/git";
import type { CloudBrainSignIns } from "@openorc/protocol";
import type { CodexBrowserSignIn } from "./codex-cloud-login.js";
import type { MemoryService } from "./memory.js";

/** The sign-ins besides Claude's that the brain holds, as this Mac last sent or heard, kept in its protected record. Records from before lack them. */
export interface SignInRecord {
  /** The brain's own Codex login, without the login itself; null while it has none. */
  codex?: Omit<HandoverCodexLogin, "auth"> | null;
  /** A Codex login made for the brain, or null to sign it out, held here only until the brain takes it. */
  codexNext?: HandoverCodexLogin | null;
  /** Switched on, the brain has this Mac's GitHub sign-in; `sent` is the signInPrint of the one it holds, null for none. */
  github?: { on: boolean; sent: string | null };
  /** The id of the push key the brain holds; null while it holds none. */
  push?: string | null;
  /** The signInPrint of the memory's Anthropic API key the brain holds; null while it holds none. */
  memory?: string | null;
  /** The signInPrint of the OpenCode keys the brain holds; null while it holds none. */
  opencode?: string | null;
  /** The signInPrint of where the brain's threads run, as it holds it; null while it holds none and runs them where it lives. */
  cloud?: string | null;
}

export type MacGitHub = NonNullable<HandoverValues["github"]> | { blocked: string };
export type PushKey = NonNullable<HandoverValues["push"]>;

/** This Mac's sign-ins that the brain is kept on, and the browser sign-in that makes the brain its own Codex login. */
export interface SignInSources {
  /** Asked again at once when `fresh`, as when the switch moves. */
  github(fresh?: boolean): Promise<MacGitHub>;
  push(): Promise<PushKey | null>;
  /** The Anthropic API key the brain's memory distils with: this Mac's, while its own does. */
  memory(): Promise<string | null>;
  /** OpenCode's provider keys for the cloud. */
  opencode(): Promise<{ provider: string; key: string }[]>;
  codex: Pick<CodexBrowserSignIn, "signingIn" | "error" | "start" | "cancel" | "finished">;
}

/** For a host that keeps the brain on Claude's sign-ins alone, as in tests. */
export const NO_SIGN_INS: SignInSources = {
  github: async () => ({ blocked: "This build doesn't send GitHub sign-ins." }),
  push: async () => null,
  memory: async () => null,
  opencode: async () => [],
  codex: { signingIn: false, error: null, start: () => undefined, cancel: () => undefined, finished: async () => undefined },
};

type Others = Omit<BrainHandover, "claude">;
type Edit = (record: SignInRecord) => void;

const shownCodex = ({ id, mode, email, plan }: HandoverCodexLogin): Omit<HandoverCodexLogin, "auth"> => ({ id, mode, email, plan });

function setGitHub(record: SignInRecord, github: SignInRecord["github"]): void {
  if (github) record.github = github;
  else delete record.github;
}

async function githubChange(github: SignInRecord["github"], mac: () => Promise<MacGitHub>): Promise<{ value: Others["github"]; edit: Edit } | null> {
  if (!github) return null;
  if (!github.on) return github.sent === null ? null : { value: null, edit: (record) => setGitHub(record, undefined) };
  const current = await mac();
  // Signed out on this Mac: the brain keeps the one it has.
  if ("blocked" in current) return null;
  const sent = signInPrint(current);
  return sent === github.sent ? null : { value: current, edit: (record) => setGitHub(record, { on: true, sent }) };
}

/** This Mac's Anthropic API key only while its memory is on and distils with it, so the brain never keeps one unused. */
export async function macMemoryKey(memory: Pick<MemoryService, "choice" | "apiKey">): Promise<string | null> {
  const { enabled, provider } = memory.choice();
  return enabled && provider === "apikey" ? memory.apiKey() : null;
}

async function memoryChange(sent: string | null | undefined, mac: () => Promise<string | null>): Promise<{ value: Others["memory"]; print: string | null } | null> {
  const apiKey = await mac();
  const print = apiKey ? signInPrint({ apiKey }) : null;
  return (sent ?? null) === print ? null : { value: apiKey ? { apiKey } : null, print };
}

async function openCodeChange(sent: string | null | undefined, mac: () => Promise<{ provider: string; key: string }[]>): Promise<{ value: Others["opencode"]; print: string | null } | null> {
  const keys = [...(await mac())].sort((a, b) => (a.provider < b.provider ? -1 : 1));
  const print = keys.length ? signInPrint({ keys }) : null;
  return (sent ?? null) === print ? null : { value: keys.length ? { keys } : null, print };
}

/** Where the brain's threads run, which follows Settings; null while nothing is connected, so the brain keeps what it has. */
export type CloudSource = () => Promise<HandoverValues["cloud"] | null>;

async function cloudChange(sent: string | null | undefined, mac: CloudSource | undefined): Promise<{ value: HandoverValues["cloud"]; print: string } | null> {
  const value = mac ? await mac() : null;
  const print = value && signInPrint(value);
  return value && print && print !== sent ? { value, print } : null;
}

/**
 * What to hand the brain, beside Claude's list, so it matches this Mac, and the record once it took that. The handover
 * is empty when it matches.
 */
export async function signInChanges(
  record: SignInRecord,
  sources: Pick<SignInSources, "github" | "push" | "memory" | "opencode"> & { cloud?: CloudSource },
): Promise<{ handover: Others; took: <T extends SignInRecord>(record: T) => T }> {
  const handover: Others = {};
  const edits: Edit[] = [];
  const next = record.codexNext;
  if (next !== undefined) {
    handover.codex = next;
    edits.push((taken) => {
      taken.codex = next && shownCodex(next);
      delete taken.codexNext;
    });
  }
  const github = await githubChange(record.github, () => sources.github());
  if (github) {
    handover.github = github.value;
    edits.push(github.edit);
  }
  const push = await sources.push();
  if ((record.push ?? null) !== (push?.keyId ?? null)) {
    handover.push = push;
    edits.push((taken) => {
      taken.push = push?.keyId ?? null;
    });
  }
  const memory = await memoryChange(record.memory, () => sources.memory());
  if (memory) {
    handover.memory = memory.value;
    edits.push((taken) => {
      taken.memory = memory.print;
    });
  }
  const opencode = await openCodeChange(record.opencode, () => sources.opencode());
  if (opencode) {
    handover.opencode = opencode.value;
    edits.push((taken) => {
      taken.opencode = opencode.print;
    });
  }
  const cloud = await cloudChange(record.cloud, sources.cloud);
  if (cloud) {
    handover.cloud = cloud.value;
    edits.push((taken) => {
      taken.cloud = cloud.print;
    });
  }
  const took = <T extends SignInRecord>(current: T): T => {
    const taken = { ...current };
    for (const edit of edits) edit(taken);
    return taken;
  };
  return { handover, took };
}

/** Whether the record says the brain holds any of them, so asking it could find one gone. */
export const claimsSignIns = (record: SignInRecord): boolean => Boolean(record.codex || record.github?.sent || record.push || record.memory || record.opencode || record.cloud);

/** The record once the brain said what it holds: its word wins, as after its disk went back to an empty snapshot. */
export function heardSignIns<T extends SignInRecord>(record: T, holds: BrainControlResults["sign-ins"]): T {
  const heard = { ...record };
  // None, or a login this record cannot name: either way, not one to show.
  if (record.codex?.id !== holds.codex) heard.codex = null;
  const on = record.github?.on ?? false;
  setGitHub(heard, on || holds.github ? { on, sent: holds.github } : undefined);
  heard.push = holds.push;
  heard.memory = holds.memory;
  heard.opencode = holds.opencode ?? null;
  heard.cloud = holds.cloud ?? null;
  return heard;
}

function pendingCodex(next: SignInRecord["codexNext"]): CloudBrainSignIns["codex"]["pending"] {
  if (next === undefined) return null;
  return next ? { mode: next.mode, email: next.email, plan: next.plan } : "sign-out";
}

/** What Settings shows of them: what the brain has, what waits to reach it, and whether this Mac's changed since. */
export async function signInsView(record: SignInRecord, sources: SignInSources): Promise<CloudBrainSignIns> {
  const { handover } = await signInChanges(record, sources);
  const on = record.github?.on ?? false;
  // Why not: for a switch that cannot move, or one switched on with nothing sent while this Mac has nothing to send.
  const mac = on && record.github?.sent ? null : await sources.github();
  const { codex } = sources;
  return {
    codex: {
      mode: record.codex?.mode ?? null,
      email: record.codex?.email ?? null,
      plan: record.codex?.plan ?? null,
      signingIn: codex.signingIn,
      pending: pendingCodex(record.codexNext),
      error: codex.error,
    },
    github: { on, blocked: mac && "blocked" in mac ? mac.blocked : null, behind: "github" in handover },
    push: { has: (record.push ?? null) !== null, behind: "push" in handover },
    memory: { has: (record.memory ?? null) !== null, behind: "memory" in handover },
  };
}

/** The record once the GitHub switch moved: switched off with nothing on the brain, it names no GitHub at all. */
export function switchGitHub<T extends SignInRecord>(record: T, on: boolean): T {
  const switched = { ...record };
  const sent = record.github?.sent ?? null;
  setGitHub(switched, on || sent ? { on, sent } : undefined);
  return switched;
}

const NO_GH = "The GitHub CLI isn't installed on this Mac.";
const SIGNED_OUT = "The GitHub CLI isn't signed in to github.com on this Mac.";
const GH_EVERY_MS = 30_000;

type Run = (bin: "gh" | "git", args: string[]) => Promise<{ stdout: string; code: number }>;
const runHere: Run = (bin, args) => {
  const options = { timeoutMs: 10_000, okCodes: [0, 1] };
  return bin === "gh" ? run("gh", os.homedir(), args, options) : git(os.homedir(), args, options);
};

async function readGitHub(command: Run): Promise<MacGitHub> {
  let token: string;
  try {
    const answer = await command("gh", ["auth", "token", "--hostname", "github.com"]);
    token = answer.code === 0 ? answer.stdout.trim() : "";
  } catch (error) {
    return { blocked: error instanceof GitError && error.code !== null ? SIGNED_OUT : NO_GH };
  }
  if (!token) return { blocked: SIGNED_OUT };
  const config = async (key: string) => (await command("git", ["config", "--global", "--get", key]).catch(() => null))?.stdout.trim() || null;
  return { token, name: await config("user.name"), email: await config("user.email") };
}

/**
 * The GitHub CLI's sign-in on this Mac for github.com, which its pull requests use, with the author its commits carry:
 * the brain gets exactly that. Asked at most every 30 s unless `fresh`, since the status asks too.
 */
export function macGitHub(command: Run = runHere): (fresh?: boolean) => Promise<MacGitHub> {
  let last: { at: number; answer: Promise<MacGitHub> } | null = null;
  return (fresh = false) => {
    if (fresh || !last || Date.now() - last.at >= GH_EVERY_MS) last = { at: Date.now(), answer: readGitHub(command) };
    return last.answer;
  };
}

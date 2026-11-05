import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeProviderId } from "@openorc/protocol";
import type { EnvSnapshot } from "./shell-environment.js";

/** A provider this Mac's OpenCode signs in to: with an API key, which may be copied, or with an account, which may not. */
export interface MacOpenCodeSignIn {
  provider: string;
  key: string | null;
}

type Json = Record<string, unknown>;

async function readJson(file: string): Promise<Json | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

const homeOf = (env: NodeJS.ProcessEnv) => env["HOME"] || os.homedir();

/**
 * This Mac's Codex's OpenAI API key, when Codex signs in with one; null for a ChatGPT login, which is never copied: its
 * refresh token works once, so two machines using it sign each other out. Codex keeps its login in `auth.json` in its
 * folder unless it is set to keep it in the keychain, which OpenOrc never reads.
 */
export async function macCodexApiKey(env: NodeJS.ProcessEnv): Promise<string | null> {
  const auth = await readJson(path.join(env["CODEX_HOME"] || path.join(homeOf(env), ".codex"), "auth.json"));
  const key = auth?.["OPENAI_API_KEY"];
  if (typeof key !== "string" || !key.trim() || auth?.["tokens"] || auth?.["auth_mode"] === "chatgpt") return null;
  return key.trim();
}

type ServiceCredential = { integrationID?: unknown; active?: unknown; value?: { type?: unknown; key?: unknown } };

/** Each provider's credential in use, the active one where OpenCode keeps several. */
function serviceSignIns(entries: ServiceCredential[]): MacOpenCodeSignIn[] {
  const chosen = new Map<string, ServiceCredential>();
  for (const entry of entries) {
    const provider = entry.integrationID;
    if (typeof provider === "string" && (entry.active === true || !chosen.has(provider))) chosen.set(provider, entry);
  }
  return [...chosen].map(([provider, entry]) => ({ provider, key: entry.value?.type === "key" && typeof entry.value.key === "string" ? entry.value.key : null }));
}

/** OpenCode 1's file: an `api` entry holds a key; `oauth` and `wellknown` ones sign in with an account. */
function legacySignIns(auth: Json): MacOpenCodeSignIn[] {
  return Object.entries(auth).map(([id, entry]) => {
    const { type, key } = (entry ?? {}) as { type?: unknown; key?: unknown };
    return { provider: id.replace(/\/+$/, ""), key: type === "api" && typeof key === "string" ? key : null };
  });
}

/**
 * The providers this Mac's OpenCode signs in to. OpenCode 2 keeps them in its background service, which lists them,
 * secrets included, with the password in the file it registers itself in; OpenCode 1 kept them in auth.json, which
 * OpenCode 2 imports once and then leaves as it was. Empty when neither answers.
 */
export async function macOpenCodeSignIns(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<MacOpenCodeSignIn[]> {
  const home = homeOf(env);
  const service = await readJson(path.join(env["XDG_STATE_HOME"] || path.join(home, ".local", "state"), "opencode", "service.json"));
  let found: MacOpenCodeSignIn[];
  if (service) {
    if (typeof service["url"] !== "string") return [];
    const password = typeof service["password"] === "string" ? service["password"] : null;
    const headers: Record<string, string> = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
    const answer = await fetcher(new URL("/api/credential", service["url"]), { headers, signal: AbortSignal.timeout(5000) }).catch(() => null);
    const body = answer?.ok ? ((await answer.json().catch(() => null)) as { data?: unknown } | null) : null;
    found = Array.isArray(body?.data) ? serviceSignIns(body.data as ServiceCredential[]) : [];
  } else {
    const legacy = await readJson(path.join(env["XDG_DATA_HOME"] || path.join(home, ".local", "share"), "opencode", "auth.json"));
    found = legacy ? legacySignIns(legacy) : [];
  }
  return found.filter(({ provider }) => OpenCodeProviderId.safeParse(provider).success).sort((a, b) => (a.provider < b.provider ? -1 : 1));
}

/**
 * What this Mac may copy to the cloud. Only static keys: never the Mac's own Claude login, which OpenOrc never reads
 * and which two machines renewing would sign each other out of, nor a ChatGPT login, whose refresh token works once.
 * Each of those takes one approval in the browser instead.
 */
export interface MacSignIns {
  codexInstalled(): boolean;
  codexApiKey(fresh?: boolean): Promise<string | null>;
  /** Asked at most every 30 s unless `fresh`, since Settings asks often. */
  opencode(fresh?: boolean): Promise<MacOpenCodeSignIn[]>;
}

const OPENCODE_EVERY_MS = 30_000;

export function macSignIns(environment: () => Pick<EnvSnapshot, "env" | "binaries">, fetcher: typeof fetch = fetch): MacSignIns {
  let last: { at: number; answer: Promise<MacOpenCodeSignIn[]> } | null = null;
  return {
    codexInstalled: () => Boolean(environment().binaries.codex),
    codexApiKey: () => macCodexApiKey(environment().env),
    opencode: (fresh = false) => {
      if (fresh || !last || Date.now() - last.at >= OPENCODE_EVERY_MS) last = { at: Date.now(), answer: macOpenCodeSignIns(environment().env, fetcher) };
      return last.answer;
    },
  };
}

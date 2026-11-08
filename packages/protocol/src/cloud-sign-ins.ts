import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";

/** A provider as OpenCode names it in a model id, `provider/model`. */
export const OpenCodeProviderId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** OpenCode's own provider, whose free models need no key. */
export const OPENCODE_FREE_PROVIDER = "opencode";

/** The provider a model id `provider/model` names; null for an id without one. */
export const openCodeProvider = (model: string | null | undefined): string | null => (model?.includes("/") ? model.slice(0, model.indexOf("/")) : null);

/** How the providers people most often add are written; any other reads as OpenCode names it. */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  opencode: "OpenCode Zen",
};
export const openCodeProviderName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/**
 * One thing the cloud signs in with: a Claude account's token, the Codex login this Mac's sandboxes use, the cloud
 * brain's own Codex login, an OpenCode provider's key, or this Mac's GitHub sign-in on the brain.
 */
export const CloudSignInTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude"), accountId: ClaudeAccountId }).strict(),
  z.object({ kind: z.literal("codex") }).strict(),
  z.object({ kind: z.literal("brain-codex") }).strict(),
  z.object({ kind: z.literal("opencode"), provider: OpenCodeProviderId }).strict(),
  z.object({ kind: z.literal("github") }).strict(),
]);
export type CloudSignInTarget = z.infer<typeof CloudSignInTarget>;

/**
 * How a sign-in gets ready: one approval in the browser, or in a private window for an added Claude account; a copy of
 * this Mac's own static key, once the person agrees; or a key typed in, for an OpenCode provider this Mac signs in to
 * with an account, which the cloud cannot use.
 */
export type CloudSignInWay = "browser" | "private-window" | "copy" | "key";

export type CloudSignIn = CloudSignInTarget & {
  label: string;
  state: "ready" | "missing" | "working" | "failed";
  way: CloudSignInWay;
  /** Why the last attempt failed. */
  error: string | null;
};

/** Every sign-in the cloud can use, in the order they are brought. */
export interface CloudSignIns {
  rows: CloudSignIn[];
  /** Bringing them is under way, one at a time. */
  bringing: boolean;
}

/** The target a row is about, as `cloud.signIns.bring` takes it. */
export function signInTarget(row: CloudSignIn): CloudSignInTarget {
  if (row.kind === "claude") return { kind: "claude", accountId: row.accountId };
  return row.kind === "opencode" ? { kind: "opencode", provider: row.provider } : { kind: row.kind };
}

/** One name per sign-in, the same for a target and its row. */
export function signInKey(target: CloudSignInTarget): string {
  if (target.kind === "claude") return `claude:${target.accountId}`;
  return target.kind === "opencode" ? `opencode:${target.provider}` : target.kind;
}

export const cloudSignInRpcParams = {
  "cloud.signIns": z.object({}),
  /** Brings every missing sign-in, one at a time, then hands them to the cloud brain. Copies only with `copy`, the person's yes. */
  "cloud.signIns.bringAll": z.object({ copy: z.boolean() }).strict(),
  /** Brings one; asking for a copy is the person's yes to it. */
  "cloud.signIns.bring": z.object({ target: CloudSignInTarget }).strict(),
  /** Stops after the sign-in under way. */
  "cloud.signIns.cancel": z.object({}),
};

export interface CloudSignInRpcResults {
  "cloud.signIns": CloudSignIns;
  "cloud.signIns.bringAll": CloudSignIns;
  "cloud.signIns.bring": CloudSignIns;
  "cloud.signIns.cancel": CloudSignIns;
}

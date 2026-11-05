import { describe, expect, it } from "vitest";
import { SHARED_CLAUDE_CONFIG_DIR } from "@openorc/agents";
import { ClaudeCloudSignIn } from "./cloud-agent-env.js";
import type { EnvSnapshot } from "./shell-environment.js";

const accounts = {
  defaultId: () => "cli",
  require: (id: string) => ({ name: id === "work" ? "Work" : "Claude Code login" }) as never,
  environment: (snapshot: EnvSnapshot, id?: string) =>
    ({
      ...snapshot,
      env:
        id === "work"
          ? { ...snapshot.env, CLAUDE_CONFIG_DIR: "/data/claude-accounts/work", CLAUDE_CODE_REMOTE_MEMORY_DIR: "/Users/me/.claude", [SHARED_CLAUDE_CONFIG_DIR]: "/Users/me/.claude" }
          : snapshot.env,
    }) as EnvSnapshot,
};
const snapshot = () => ({ env: { PATH: "/usr/bin", HOME: "/Users/me" } }) as unknown as EnvSnapshot;
/** What a turn's process gets: the sign-in's folder variables, then its credentials, as a cloud turn merges them. */
const environment = (saved: Record<string, string>) => {
  const signIn = new ClaudeCloudSignIn({ accounts, tokens: { token: async (id: string) => saved[id] ?? null }, snapshot });
  return async (provider: "local" | "vercel", claudeAccountId: string | null) => {
    const who = { claudeAccountId, model: null };
    await signIn.assertCanRun(provider, who);
    return { ...(await signIn.homeEnv("/state", provider, who)), ...(await signIn.prepare(async () => null, provider, who)) };
  };
};

describe("how a Claude account's agent signs in to a sandbox", () => {
  it("uses the thread's account token, or the default account's", async () => {
    const env = environment({ work: "sk-ant-oat01-work", cli: "sk-ant-oat01-cli" });
    expect(await env("vercel", "work")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-work" });
    expect(await env("vercel", null)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-cli" });
  });

  it("refuses a real sandbox for an account without a token, naming the account", async () => {
    await expect(environment({})("vercel", "work")).rejects.toThrow("“Work” has no token for cloud threads. Create one in Settings → Cloud.");
  });

  it("lets a sandbox on this Mac use the account's own login when it has no token", async () => {
    const env = environment({});
    expect(await env("local", "work")).toEqual({
      CLAUDE_CONFIG_DIR: "/data/claude-accounts/work",
      CLAUDE_CODE_REMOTE_MEMORY_DIR: "/Users/me/.claude",
      [SHARED_CLAUDE_CONFIG_DIR]: "/Users/me/.claude",
    });
    expect(await env("local", "cli")).toEqual({});
  });

  it("names only its folder among the home's variables, and keeps the account's login apart as the turn's credentials", async () => {
    const signIn = new ClaudeCloudSignIn({ accounts, tokens: { token: async () => null }, snapshot });
    const who = { claudeAccountId: "work", model: null };
    expect(await signIn.homeEnv("/state", "local", who)).toEqual({ CLAUDE_CONFIG_DIR: "/data/claude-accounts/work" });
    expect(await signIn.prepare(async () => null, "local", who)).toEqual({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "/Users/me/.claude", [SHARED_CLAUDE_CONFIG_DIR]: "/Users/me/.claude" });
  });
});

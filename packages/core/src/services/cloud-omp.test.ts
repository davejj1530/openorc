import { describe, expect, it } from "vitest";
import { OUTSIDE_THE_SANDBOX } from "./cloud-agents.js";
import { OmpCloudSignIn } from "./cloud-omp.js";

const keys = { key: async (provider: string) => ({ anthropic: "sk-ant-real", openrouter: "sk-or-real" })[provider] ?? null };
const who = (model: string | null) => ({ claudeAccountId: null, model });

describe("Oh My Pi in the cloud", () => {
  it("signs in with only the key of its model's provider, kept outside the sandbox where the firewall can add it", async () => {
    const signIn = new OmpCloudSignIn(keys);
    expect(await signIn.prepare(undefined, "vercel", who("anthropic/claude-haiku-5-5"), true)).toEqual({
      env: { ANTHROPIC_API_KEY: `sk-${OUTSIDE_THE_SANDBOX}` },
      headers: [{ domain: "api.anthropic.com", name: "x-api-key", value: "sk-ant-real" }],
    });
    expect(await signIn.prepare(undefined, "vercel", who("openrouter/acme/fast"), false)).toEqual({ env: { OPENROUTER_API_KEY: "sk-or-real" }, headers: [] });
    expect(await signIn.homeEnv("/state")).toEqual({ PI_CODING_AGENT_DIR: "/state/omp" });
  });

  it("refuses, before a turn, a model with no key there or a provider that signs in with an account", async () => {
    const signIn = new OmpCloudSignIn(keys);
    await expect(signIn.assertCanRun("vercel", who("openai/gpt-6-sol"))).rejects.toThrow("no key for OpenAI in the cloud");
    await expect(signIn.assertCanRun("vercel", who("openai-codex/gpt-6-sol"))).rejects.toThrow("runs in the cloud with a provider API key");
    await expect(signIn.assertCanRun("vercel", who(null))).rejects.toThrow("Choose a model");
  });
});

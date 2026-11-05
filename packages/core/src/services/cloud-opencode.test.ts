import { describe, expect, it } from "vitest";
import { OpenCodeCloudKeys, OpenCodeCloudSignIn } from "./cloud-opencode.js";

function store(initial: string | null = null) {
  let saved = initial;
  return { load: async () => saved, save: async (value: string) => void (saved = value), read: () => saved };
}

describe("OpenCode's keys for the cloud", () => {
  it("keeps one key per provider, says which providers have one and never which key, and adopts exactly a handed-over set", async () => {
    const kept = store();
    let changes = 0;
    const keys = new OpenCodeCloudKeys(kept, () => changes++);
    await keys.save("openrouter", "sk-or-1");
    await keys.save("anthropic", "sk-ant-1");
    await keys.save("openrouter", "sk-or-2");
    expect(await keys.providers()).toEqual(["anthropic", "openrouter"]);
    expect(await keys.key("openrouter")).toBe("sk-or-2");
    await keys.remove("anthropic");
    expect(await new OpenCodeCloudKeys(store(kept.read())).all()).toEqual([{ provider: "openrouter", key: "sk-or-2" }]);
    await keys.adopt([{ provider: "openai", key: "sk-oa" }]);
    expect(await keys.providers()).toEqual(["openai"]);
    expect(changes).toBe(5);
  });
});

describe("OpenCode signing in to a sandbox", () => {
  const keys = new OpenCodeCloudKeys(store(JSON.stringify({ openrouter: { key: "sk-or", createdAt: 1 }, anthropic: { key: "sk-ant", createdAt: 1 } })));
  const signIn = new OpenCodeCloudSignIn(keys);
  const who = (model: string | null) => ({ claudeAccountId: null, model });

  it("hands a turn only the key of the provider serving its model, in the run's settings, and its own database folder", async () => {
    const env = await signIn.prepare(async () => null, "vercel", who("openrouter/acme/fast"));
    expect(Object.keys(env)).toEqual(["OPENCODE_CONFIG_CONTENT"]);
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!)).toEqual({ provider: { openrouter: { options: { apiKey: "sk-or" } } } });
    expect(env["OPENCODE_CONFIG_CONTENT"]).not.toContain("sk-ant");
    expect(await signIn.homeEnv("/vercel/sandbox/.openorc")).toEqual({ XDG_DATA_HOME: "/vercel/sandbox/.openorc/opencode" });
  });

  it("refuses a model whose provider has no key in words, and needs none for OpenCode's own free models", async () => {
    await expect(signIn.assertCanRun("vercel", who("openai/gpt-5"))).rejects.toThrow("OpenCode has no key for OpenAI in the cloud. Add one in Settings > Cloud.");
    await expect(signIn.assertCanRun("local", who("openai/gpt-5"))).rejects.toThrow("OpenCode has no key for OpenAI");
    await signIn.assertCanRun("vercel", who("opencode/big-pickle"));
    expect(await signIn.prepare(async () => null, "vercel", who("opencode/big-pickle"))).toEqual({});
  });
});

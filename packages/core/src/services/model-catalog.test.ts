import { describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@openorc/protocol";
import { ModelCatalogCache, type DiscoveredModels } from "./model-catalog.js";
import { claudeModelLabel, claudeModelsFrom, withClaudeAccountFastMode, withClaudeLegacyModels } from "./claude-model-catalog.js";

const model: ModelOption = {
  agent: "claude",
  id: "claude-sonnet-5",
  label: "Sonnet 5",
  isDefault: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
  fastMode: { supported: false },
};
const result = (id = model.id): DiscoveredModels => ({ models: [{ ...model, id }] });

describe("catalog cache", () => {
  it("coalesces concurrent reads, expires after five minutes and forces refresh", async () => {
    let now = 1000;
    const cache = new ModelCatalogCache(() => now);
    const discover = vi.fn(async () => result());
    await Promise.all([cache.read("claude", 1, discover), cache.read("claude", 1, discover, true)]);
    await cache.read("claude", 1, discover);
    expect(discover).toHaveBeenCalledTimes(1);
    now += 300_000;
    await cache.read("claude", 1, discover);
    await cache.read("claude", 1, discover, true);
    expect(discover).toHaveBeenCalledTimes(3);
  });
  it("keeps last-good data and provider error state without crossing revisions", async () => {
    const cache = new ModelCatalogCache();
    await cache.read("claude", 1, async () => result());
    const fail = async () => {
      throw new Error("private stderr");
    };
    const stale = await cache.read("claude", 1, fail, true);
    expect(stale.models).toHaveLength(1);
    expect(stale.provider.status).toBe("stale");
    expect(JSON.stringify(stale)).not.toContain("private stderr");
    expect((await cache.read("codex", 1, async () => result("gpt-new"))).provider.status).toBe("ready");
    expect(await cache.read("claude", 2, fail)).toMatchObject({ models: [], provider: { status: "error" } });
  });
  it("does not replace a live list with fallback or let an old revision overwrite a new one", async () => {
    const cache = new ModelCatalogCache();
    let finish!: (result: DiscoveredModels) => void;
    const old = cache.read(
      "claude",
      1,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    await cache.read("claude", 2, async () => result("new"));
    finish(result("old"));
    await old;
    expect((await cache.read("claude", 2, async () => result("unused"))).models[0]?.id).toBe("new");
    const fallback = await cache.read("claude", 2, async () => ({ ...result("fallback"), message: "Compatibility catalog" }), true);
    expect(fallback.models[0]?.id).toBe("new");
    expect(fallback.provider.status).toBe("stale");
  });
});

describe("Claude pinned discovery", () => {
  it("discovers unknown versions, deduplicates aliases and prefers pinned Sonnet", () => {
    const catalog = claudeModelsFrom(
      [
        { value: "default", resolvedModel: "claude-opus-9[1m]", displayName: "Default", supportsFastMode: true, supportedEffortLevels: ["high", "xhigh", "max"] },
        { value: "opus[1m]", resolvedModel: "claude-opus-9[1m]", displayName: "Opus 9", supportsFastMode: true, supportedEffortLevels: ["high", "xhigh", "max"] },
        { value: "sonnet", resolvedModel: "claude-sonnet-9", displayName: "Sonnet 9", supportsEffort: false },
      ],
      [model],
      true,
      {},
    );
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-opus-9[1m]", "claude-sonnet-9"]);
    expect(catalog.models[0]).toMatchObject({ efforts: ["high", "xhigh", "max", "ultracode"], fastMode: { supported: true }, isDefault: false });
    expect(catalog.models[1]).toMatchObject({ efforts: [], isDefault: true });
    expect(model.id).toBe("claude-sonnet-5");
  });
  it("does not invent capabilities, pin latest aliases, or bypass connection restrictions", () => {
    const catalog = claudeModelsFrom(
      [
        { value: "claude-new-8", displayName: "New" },
        { value: "opus", resolvedModel: "claude-opus-9", displayName: "Opus", supportsFastMode: true, supportedEffortLevels: ["low", "high"] },
        { value: "claude-sonnet-latest", displayName: "Latest" },
      ],
      [model],
      true,
      { CLAUDE_CODE_DISABLE_FAST_MODE: "1" },
    );
    expect(catalog.models[0]).toMatchObject({ efforts: [], defaultEffort: null, isDefault: true });
    expect(catalog.models[1]?.fastMode?.supported).toBe(false);
    expect(catalog.models[1]?.efforts).not.toContain("ultracode");
    expect(catalog.models[2]?.unavailable).toMatch(/pinned/);
  });
  it("names each model by the version its pinned ID verifies, never by the alias alone", () => {
    const catalog = claudeModelsFrom(
      [
        { value: "opus", resolvedModel: "claude-opus-4-6", displayName: "Opus" },
        { value: "opus[1m]", resolvedModel: "claude-opus-4-6[1m]", displayName: "Opus (1M context)" },
        { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
        { value: "sonnet", displayName: "Sonnet" },
      ],
      [model],
      false,
      {},
    );
    expect(catalog.models.map((m) => [m.id, m.label])).toEqual([
      ["claude-opus-4-6", "Opus 4.6"],
      ["claude-opus-4-6[1m]", "Opus 4.6 (1M context)"],
      ["claude-haiku-4-5-20251001", "Haiku 4.5"],
      ["sonnet", "Sonnet"],
    ]);
    expect(catalog.models[3]?.unavailable).toMatch(/Update Claude Code/);
    expect(claudeModelLabel("claude-3-5-sonnet-20241022", "Sonnet")).toBe("Sonnet 3.5");
    expect(claudeModelLabel("claude-sonnet-latest", "Sonnet")).toBe("Sonnet");
  });
  it("uses known capabilities only when missing and labels alias-only compatibility fallback", () => {
    expect(claudeModelsFrom([{ value: model.id, displayName: "Sonnet" }], [model], false, {}).models[0]?.efforts).toEqual(model.efforts);
    expect(claudeModelsFrom([{ value: "sonnet", displayName: "Sonnet" }], [model], false, {})).toMatchObject({ models: [model], message: expect.stringContaining("Compatibility catalog") });
  });
});

describe("Claude legacy models", () => {
  const legacy = (id: string, label: string): ModelOption => ({ ...model, id, label, isDefault: true });
  it("follows the CLI's rows, is never the default, and yields to a live row with or without 1M context", () => {
    const live = claudeModelsFrom([{ value: "opus[1m]", resolvedModel: "claude-opus-4-8[1m]", displayName: "Opus (1M context)" }], [model], false, {});
    const catalog = withClaudeLegacyModels(live, [legacy("claude-opus-4-8", "Opus 4.8"), legacy("claude-opus-4-6", "Opus 4.6")]);
    expect(catalog.models.map((m) => [m.id, m.legacy ?? false, m.isDefault])).toEqual([
      ["claude-opus-4-8[1m]", false, true],
      ["claude-opus-4-6", true, false],
    ]);
  });
  it("keeps the compatibility message and its rows ahead of legacy ones", () => {
    const catalog = withClaudeLegacyModels({ models: [model], message: "Compatibility catalog" }, [legacy("claude-opus-4-6", "Opus 4.6")]);
    expect(catalog.message).toBe("Compatibility catalog");
    expect(catalog.models.map((m) => m.id)).toEqual(["claude-sonnet-5", "claude-opus-4-6"]);
  });
});

describe("Claude account Fast access", () => {
  const fast = (id: string): ModelOption => ({ ...model, id, fastMode: { supported: true } });
  const discovered: DiscoveredModels = { models: [fast("claude-opus-9[1m]"), model, { ...fast("claude-opus-4-8"), legacy: true }] };
  it("takes Fast off every model, legacy ones too, when the account cannot use it", () => {
    const catalog = withClaudeAccountFastMode(discovered, "extra_usage_disabled");
    expect(catalog.models.map((m) => m.fastMode)).toEqual([
      { supported: false, reason: expect.stringContaining("usage credits") },
      { supported: false },
      { supported: false, reason: expect.stringContaining("usage credits") },
    ]);
  });
  it("keeps Fast when nothing definite blocks the account", () => {
    // A pending check, a session that did not opt in, a code this app does not know yet, and an
    // allowed-models check that ran against the CLI's default model instead of each row.
    for (const code of [undefined, "pending", "sdk_opt_in_required", "some_future_code", "model_not_allowed"]) {
      expect(withClaudeAccountFastMode(discovered, code)).toBe(discovered);
    }
  });
});

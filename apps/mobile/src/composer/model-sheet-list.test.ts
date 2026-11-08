import type { ModelOption } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { sheetList } from "./model-sheet-list";

const model = (id: string, more: Partial<ModelOption> = {}): ModelOption => ({ id, label: id, agent: "opencode", isDefault: false, efforts: [], defaultEffort: null, ...more });
const many = (provider: string, count: number, more: Partial<ModelOption> = {}) =>
  Array.from({ length: count }, (_, index) => model(`${provider}/m${index}`, { label: `${provider} ${index}`, provider: { id: provider, label: provider }, ...more }));

const catalog = [
  ...many("Anthropic", 5),
  model("Anthropic/old", { label: "Old Claude", legacy: true, provider: { id: "Anthropic", label: "Anthropic" } }),
  ...many("Bedrock", 20),
  model("Bedrock/m3-default", { label: "Bedrock default", isDefault: true, provider: { id: "Bedrock", label: "Bedrock" } }),
  model("gpt", { label: "GPT", agent: "codex", isDefault: true }),
];
const base = { catalog, agent: "opencode" as const, choice: null, recents: [], query: "", provider: null };

describe("the phone's Model sheet list", () => {
  it("lists an agent with few models whole, without older ones", () => {
    expect(sheetList({ ...base, agent: "codex" })).toEqual({ kind: "all", models: [{ model: catalog.at(-1), note: null }] });
  });

  it("opens an agent with many models on the current, recent and default ones, then a row per provider", () => {
    const list = sheetList({ ...base, choice: { agent: "opencode", model: "Anthropic/m1", effort: null }, recents: ["codex:gpt", "opencode:Bedrock/m4", "opencode:Anthropic/m1"] });
    expect(list).toEqual({
      kind: "short",
      suggested: [
        { model: expect.objectContaining({ id: "Anthropic/m1" }), note: "Current · Anthropic" },
        { model: expect.objectContaining({ id: "Bedrock/m4" }), note: "Recent · Bedrock" },
        { model: expect.objectContaining({ id: "Bedrock/m3-default" }), note: "Default · Bedrock" },
      ],
      providers: [
        { label: "Anthropic", count: 5 },
        { label: "Bedrock", count: 21 },
      ],
      models: [],
    });
  });

  it("opens one provider's models, saying how many older ones are hidden", () => {
    const list = sheetList({ ...base, provider: "Anthropic" });
    expect(list).toMatchObject({ kind: "provider", provider: "Anthropic", olderHidden: 1 });
    expect(list.kind === "provider" && list.models.map((row) => row.model.id)).toEqual(["Anthropic/m0", "Anthropic/m1", "Anthropic/m2", "Anthropic/m3", "Anthropic/m4"]);
  });

  it("searches all of an agent's models, older ones too, and no other agent's", () => {
    const list = sheetList({ ...base, provider: "Bedrock", query: "old" });
    expect(list).toEqual({ kind: "search", models: [{ model: expect.objectContaining({ id: "Anthropic/old" }), note: "Anthropic · Older" }] });
    expect(sheetList({ ...base, query: "gpt" })).toEqual({ kind: "search", models: [] });
  });

  it("keeps models with missing provider labels reachable from a named group", () => {
    const catalog = [...many("Anthropic", 13), model("custom"), model("blank", { provider: { id: "blank", label: " " } })];
    const list = sheetList({ ...base, catalog });
    expect(list.kind === "short" && list.providers).toContainEqual({ label: "Other", count: 2 });
    const group = sheetList({ ...base, catalog, provider: "Other" });
    expect(group.kind === "provider" && group.models.map(({ model }) => model.id)).toEqual(["custom", "blank"]);
  });
});

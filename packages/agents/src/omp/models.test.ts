import { describe, expect, it } from "vitest";
import { ompModelsFrom } from "./models.js";
import { modelProviderName } from "../provider-name.js";

const listed = JSON.stringify({
  models: [
    { provider: "anthropic", kind: "chat", id: "claude-opus-5-5", selector: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", thinking: ["low", "medium", "high", "xhigh", "max"] },
    { provider: "openai-codex", kind: "chat", id: "gpt-6-sol", selector: "openai-codex/gpt-6-sol", name: "GPT-6 Sol", thinking: ["minimal", "low", "medium", "high"] },
    { provider: "amazon-bedrock", kind: "chat", id: "meta.llama3-1-8b", selector: "amazon-bedrock/meta.llama3-1-8b", name: "Llama 3.1 8B", thinking: null },
    { provider: "openai", kind: "image", id: "gpt-image-2", selector: "openai/gpt-image-2", name: "GPT Image 2", thinking: null },
    { provider: "anthropic", kind: "chat", id: "odd", selector: "anthropic/odd", name: "Odd", thinking: ["low", "auto", "off", "turbo", "high"] },
  ],
});

describe("Oh My Pi's model list", () => {
  it("lists chat models with the effort levels each one takes", () => {
    const models = ompModelsFrom(listed);
    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", "amazon-bedrock/meta.llama3-1-8b", "anthropic/odd"]);
    expect(models[0]).toEqual({
      id: "anthropic/claude-opus-5-5",
      label: "Claude Opus 5.5",
      provider: { id: "anthropic", label: "Anthropic" },
      isDefault: false,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    // Levels outside the scale, such as auto and off, are not offered as steps.
    expect(models[3]!.efforts).toEqual(["low", "high"]);
    expect(models[2]).toMatchObject({ efforts: [], defaultEffort: null });
  });

  it("marks the model and effort Oh My Pi's settings start with", () => {
    const models = ompModelsFrom(listed, { model: "openai-codex/gpt-6-sol", effort: "xhigh" });
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["openai-codex/gpt-6-sol"]);
    // A model without the configured level starts at the nearest one below it.
    expect(models[1]!.defaultEffort).toBe("high");
    expect(models[0]!.defaultEffort).toBe("xhigh");
  });

  it("names providers the way people know them", () => {
    expect(modelProviderName("openai-codex")).toBe("OpenAI Codex");
    expect(modelProviderName("amazon-bedrock")).toBe("Amazon Bedrock");
    expect(modelProviderName("kimi-code")).toBe("Kimi Code");
  });

  it("refuses an answer that is not a model list", () => {
    expect(() => ompModelsFrom(JSON.stringify({ error: "nope" }))).toThrow("did not list its models");
  });
});

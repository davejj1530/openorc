import { expect, it } from "vitest";
import { estimateCodexCost } from "./usage-pricing.js";

const tokens = { inputTokens: 100_000, cacheReadTokens: 800_000, cacheWriteTokens: 100_000, outputTokens: 20_000 };

it("prices ordinary input, cache reads, cache writes, and output separately", () => {
  expect(estimateCodexCost({ model: "gpt-6.1-sol", fastMode: false, tokens })).toBeCloseTo(0.73);
  expect(estimateCodexCost({ model: "openai/gpt-6.1-sol-2026-11-01", fastMode: false, tokens })).toBeCloseTo(0.73);
});

it("applies the published speed and request-context rates without using cumulative token volume as context", () => {
  expect(estimateCodexCost({ model: "gpt-6.1-sol", fastMode: true, tokens, requestInputTokens: 272_000 })).toBeCloseTo(1.46);
  expect(estimateCodexCost({ model: "gpt-6.1-sol", fastMode: false, tokens, requestInputTokens: 272_001 })).toBeCloseTo(1.36);
  expect(estimateCodexCost({ model: "gpt-5.5", fastMode: true, tokens: { ...tokens, cacheWriteTokens: 0 } })).toBeCloseTo(3.75);
});

it("supports older Codex models and leaves unknown prices unavailable", () => {
  expect(estimateCodexCost({ model: "gpt-5.3-codex", fastMode: false, tokens: { ...tokens, cacheWriteTokens: 0 } })).toBeCloseTo(0.595);
  expect(estimateCodexCost({ model: "gpt-5.1-codex-mini", fastMode: false, tokens: { ...tokens, cacheWriteTokens: 0 } })).toBeCloseTo(0.085);
  expect(estimateCodexCost({ model: "unknown-model", fastMode: false, tokens })).toBeNull();
  expect(estimateCodexCost({ model: null, fastMode: false, tokens })).toBeNull();
  expect(estimateCodexCost({ model: "gpt-5.1-codex-mini", fastMode: true, tokens })).toBeNull();
  expect(estimateCodexCost({ model: "gpt-5.5", fastMode: true, tokens, requestInputTokens: 300_000 })).toBeNull();
});

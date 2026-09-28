import { expect, it } from "vitest";
import { mapNotification } from "./notifications.js";

const state = () => ({ summaryIndex: new Map<string, number>(), buffering: new Set<string>() });

it("uses the last turn's total tokens for Codex context usage without double-counting cached input", () => {
  const events = mapNotification(
    "run",
    "thread/tokenUsage/updated",
    {
      tokenUsage: {
        total: { inputTokens: 500_000, cachedInputTokens: 300_000, outputTokens: 20_000 },
        last: { inputTokens: 190_000, cachedInputTokens: 185_380, outputTokens: 2_000, totalTokens: 192_000 },
        modelContextWindow: 258_400,
      },
    },
    state(),
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "usage.updated",
    usage: {
      inputTokens: 500_000,
      outputTokens: 20_000,
      cacheReadTokens: 300_000,
      contextTokens: 192_000,
      contextWindow: 258_400,
    },
  });
});

it("falls back to last input tokens when Codex omits last total tokens", () => {
  const events = mapNotification(
    "run",
    "thread/tokenUsage/updated",
    {
      tokenUsage: {
        total: { inputTokens: 500_000, cachedInputTokens: 300_000, outputTokens: 20_000 },
        last: { inputTokens: 190_000, cachedInputTokens: 185_380, outputTokens: 2_000 },
        modelContextWindow: 258_400,
      },
    },
    state(),
  );

  expect(events[0]).toMatchObject({ type: "usage.updated", usage: { contextTokens: 190_000 } });
});

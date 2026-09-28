import assert from "node:assert/strict";
import { it as test } from "vitest";
import { commentMentionOptions, resolveCommentMentions } from "@openorc/protocol";
import type { ModelOption } from "@openorc/protocol";
const models: ModelOption[] = [
  { agent: "codex", id: "model-with-hyphens", label: "Test", efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
  { agent: "claude", id: "no-effort", label: "No effort", efforts: [], defaultEffort: null, isDefault: true },
];
const claude: ModelOption[] = [
  { agent: "claude", id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["high", "xhigh"], defaultEffort: "high", isDefault: true },
  { agent: "claude", id: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M context)", efforts: ["high", "xhigh"], defaultEffort: "high", isDefault: false },
];
test("resolves display names, longest first, and exact tokens", () => {
  assert.deepEqual(resolveCommentMentions("@Opus 5.5 (1M context) - Extra high, then @opus 5.5 - high.", claude), [
    { agent: "claude", model: "claude-opus-5-5[1m]", effort: "xhigh" },
    { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  ]);
  assert.deepEqual(resolveCommentMentions("@model-with-hyphens-high and @codex:model-with-hyphens-high", models), [{ agent: "codex", model: "model-with-hyphens", effort: "high" }]);
  assert.throws(() => resolveCommentMentions("@Opus 5.5 - Max", claude), /Unknown agent @Opus/);
});
test("adds the harness or provider only where names would clash", () => {
  const openrouter: ModelOption = { ...models[1]!, agent: "opencode", id: "openrouter/no-effort", provider: { id: "openrouter", label: "OpenRouter" } };
  const anthropic: ModelOption = { ...openrouter, id: "anthropic/no-effort", provider: { id: "anthropic", label: "Anthropic" } };
  assert.deepEqual(
    commentMentionOptions([models[1]!, openrouter, anthropic]).map((o) => o.name),
    ["No effort (Claude Code)", "No effort (OpenCode · OpenRouter)", "No effort (OpenCode · Anthropic)"],
  );
  assert.deepEqual(
    commentMentionOptions([openrouter, anthropic]).map((o) => o.name),
    ["No effort (OpenRouter)", "No effort (Anthropic)"],
  );
  const twin: ModelOption = { ...anthropic, id: "anthropic/no-effort-latest" };
  assert.deepEqual(
    commentMentionOptions([anthropic, twin]).map((o) => o.name),
    ["opencode:anthropic/no-effort", "opencode:anthropic/no-effort-latest"],
  );
  assert.deepEqual(resolveCommentMentions("@No effort (OpenRouter) please", [openrouter, anthropic]), [{ agent: "opencode", model: "openrouter/no-effort", effort: null }]);
});
test("ignores code and quotes, and rejects missing or ambiguous recipients", () => {
  assert.deepEqual(resolveCommentMentions("`@unknown`\n> @unknown\n```\n@unknown\n```", models), []);
  assert.throws(() => resolveCommentMentions("@unknown", models), /Unknown agent/);
  const duplicate: ModelOption = { ...models[0]!, agent: "claude" };
  assert.throws(() => resolveCommentMentions("@model-with-hyphens-high", [...models, duplicate]), /Ambiguous/);
});

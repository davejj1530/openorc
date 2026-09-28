import type { MemorySettings } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { extractionSummary } from "./memory-extraction";

const base: MemorySettings = { enabled: true, provider: "auto", model: null, hasApiKey: false, resolved: null, automatic: [], reason: null };

describe("extractionSummary", () => {
  it("says nothing while memory is off", () => {
    expect(extractionSummary({ ...base, enabled: false })).toBeNull();
  });

  it("names each agent that summarizes its own runs, and the agents that are skipped", () => {
    const summary = extractionSummary({
      ...base,
      automatic: [
        { provider: "codex", model: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", viaApiKey: false },
        { provider: "claude", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", viaApiKey: false },
      ],
    });
    expect(summary).toBe("Each finished run is summarized by the agent that ran it: Codex runs by GPT-5.3-Codex-Spark and Claude Code runs by Claude Haiku 4.5. OpenCode runs are not summarized.");
  });

  it("says when one provider summarizes every agent's runs", () => {
    const summary = extractionSummary({ ...base, provider: "apikey", resolved: { provider: "claude", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", viaApiKey: true } });
    expect(summary).toBe("Every finished run, whichever agent did the work, is summarized by Claude Haiku 4.5 through your Anthropic API key.");
  });

  it("explains why nothing runs", () => {
    expect(extractionSummary({ ...base, reason: "Log in to Codex or Claude Code." })).toBe("Log in to Codex or Claude Code.");
    expect(extractionSummary({ ...base, provider: "off" })).toBe("Finished runs are not summarized. Agents can still save memories.");
  });
});

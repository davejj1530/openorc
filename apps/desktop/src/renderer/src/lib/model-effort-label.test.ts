import { describe, expect, it } from "vitest";
import type { ModelOption } from "@openorc/protocol";
import { modelEffortLabel } from "./model-effort-label";

const models: ModelOption[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", agent: "codex", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "claude-fable-5-1", label: "Fable 5.1", agent: "claude", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "high" },
];

describe("modelEffortLabel", () => {
  it("joins the catalogue name with a capitalised effort", () => {
    expect(modelEffortLabel({ agent: "codex", model: "gpt-6-astra", effort: "high" }, models)).toBe("GPT-6 Astra - High");
  });

  it("matches the catalogue entry by agent as well as id", () => {
    expect(modelEffortLabel({ agent: "claude", model: "gpt-6-astra", effort: null }, models)).toBe("gpt-6-astra");
  });
});

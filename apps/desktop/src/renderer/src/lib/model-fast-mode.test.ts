import { describe, expect, it } from "vitest";
import type { ModelOption } from "@openorc/protocol";
import { modelFastMode } from "./model-fast-mode";

const legacyModel: ModelOption = { id: "gpt-6-astra", label: "GPT-6 Astra", agent: "codex", isDefault: true, efforts: ["medium"], defaultEffort: "medium" };

describe("composer Fast availability", () => {
  it("calls Fast blocked only when the loaded catalog rules it out", () => {
    expect(modelFastMode({ ...legacyModel, fastMode: { supported: false, reason: "Usage credits are off." } }).blocked).toBe(true);
    expect(modelFastMode({ ...legacyModel, unavailable: "Needs a newer CLI." }).blocked).toBe(true);
    expect(modelFastMode({ ...legacyModel, fastMode: { supported: true } }).blocked).toBe(false);
    // Not knowing yet is not a verdict.
    expect(modelFastMode(undefined, true).blocked).toBe(false);
    expect(modelFastMode(undefined, false, true).blocked).toBe(false);
    expect(modelFastMode(legacyModel).blocked).toBe(false);
  });
});

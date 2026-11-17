import { expect, it } from "vitest";
import type { ModelOption } from "@openorc/protocol";
import { cloudRunChoice } from "./cloud-run-choice";

const cloud: ModelOption[] = [
  { id: "", label: "Claude default", agent: "claude", isDefault: true, efforts: [], defaultEffort: null },
  { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude", isDefault: false, efforts: ["high"], defaultEffort: "high" },
  { id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
];

it("starts on OpenOrc Cloud with the cloud's default for the agent when the cloud doesn't run the model chosen for this Mac", () => {
  expect(cloudRunChoice({ agent: "claude", model: "claude-sonnet-5", effort: "medium" }, cloud)).toEqual({ agent: "claude", model: "", effort: null });
});

it("keeps a model the cloud runs, and on this Mac the model chosen", () => {
  const opus = { agent: "claude", model: "claude-opus-5-5", effort: "high" } as const;
  expect(cloudRunChoice(opus, cloud)).toBe(opus);
  const sonnet = { agent: "claude", model: "claude-sonnet-5", effort: "medium" } as const;
  expect(cloudRunChoice(sonnet, undefined)).toBe(sonnet);
});

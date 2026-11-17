import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelOption } from "@openorc/protocol";
import { useCloudRunChoice } from "./cloud-run-choice";

const cloud: ModelOption[] = [
  { id: "", label: "Claude default", agent: "claude", isDefault: true, efforts: [], defaultEffort: null },
  { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude", isDefault: false, efforts: ["high"], defaultEffort: "high" },
  { id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
];
let asked: boolean[];
vi.mock("./client", () => ({
  useRpc: (method: string, _params: unknown, options: { enabled: boolean }) => (
    asked.push(options.enabled),
    { data: method === "cloudModels.catalog" && options.enabled ? { models: cloud, providers: [] } : undefined }
  ),
}));
beforeEach(() => {
  asked = [];
});

it("starts on OpenOrc Cloud with the cloud's default for the agent when the cloud doesn't run the model chosen for this Mac", () => {
  const { result } = renderHook(() => useCloudRunChoice({ agent: "claude", model: "claude-sonnet-5", effort: "medium" }, true));
  expect(result.current).toEqual({ agent: "claude", model: "", effort: null });
  expect(asked.every(Boolean)).toBe(true);
});

it("keeps a model the cloud runs, and on this Mac the model chosen", () => {
  const opus = { agent: "claude", model: "claude-opus-5-5", effort: "high" } as const;
  expect(renderHook(() => useCloudRunChoice(opus, true)).result.current).toBe(opus);
  const sonnet = { agent: "claude", model: "claude-sonnet-5", effort: "medium" } as const;
  expect(renderHook(() => useCloudRunChoice(sonnet, false)).result.current).toBe(sonnet);
});

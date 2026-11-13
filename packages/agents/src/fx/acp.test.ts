import { expect, it, vi } from "vitest";
import { executionModeUnavailable } from "@openorc/protocol";
import { selectedModel, setModelOption } from "../acp/settings.js";
import { fxAcp } from "./acp.js";

it("preserves provider-qualified model IDs when selecting and reopening models", async () => {
  const set = vi.fn(async () => []);
  await setModelOption("gateway/anthropic/example-model", fxAcp, set);
  expect(set.mock.calls).toEqual([
    ["provider", "gateway"],
    ["model", "anthropic/example-model"],
  ]);
  expect(
    selectedModel(
      [
        { id: "provider", name: "Provider", type: "select", currentValue: "gateway", options: [] },
        { id: "model", name: "Model", type: "select", currentValue: "anthropic/example-model", options: [] },
      ],
      fxAcp,
    ),
  ).toBe("gateway/anthropic/example-model");
  await expect(setModelOption("unqualified", fxAcp, set)).rejects.toThrow("model picker");
});

it("maps Ask, Auto review and Full access without promising a read-only plan", () => {
  expect(fxAcp.modeValue("act", "review")).toBe("ask");
  expect(fxAcp.modeValue("act", "trusted")).toBe("auto");
  expect(fxAcp.modeValue("act", "autonomous")).toBe("full-access");
  expect(executionModeUnavailable("fx", "plan")).toContain("read-only Plan");
});

it("does not resend steering that was absorbed before cancellation", () => {
  expect(fxAcp.steeringOutcome?.({ stopReason: "cancelled", _meta: { fx: { steering: "absorbed" } } })).toBe("accepted");
  expect(fxAcp.steeringOutcome?.({ stopReason: "cancelled", _meta: { fx: { steering: "dropped" } } })).toBe("unavailable");
});

it("does not treat error examples in an ordinary model reply as provider failures", () => {
  const example = 'HTTP 400: {"error":{"message":"insufficient_quota"}}';
  expect(fxAcp.promptOutcome?.("end_turn", example)).toBeUndefined();
  expect(fxAcp.promptOutcome?.("refused", "I cannot fulfill that request.")).toEqual({ status: "error" });
  expect(fxAcp.promptOutcome?.("refused", "HTTP 400: ordinary text")).toEqual({ status: "error" });
  expect(fxAcp.promptOutcome?.("refused", 'HTTP 400: {"example":"insufficient_quota"}')).toEqual({ status: "error" });
});

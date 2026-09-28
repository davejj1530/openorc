import { expect, it } from "vitest";
import { AgentEvent, rpcParams } from "@openorc/protocol";
import { mapNotification } from "./notifications.js";

const state = () => ({ summaryIndex: new Map<string, number>(), buffering: new Set<string>() });
it("preserves structured quota recovery on both Codex failure paths", () => {
  for (const code of ["usageLimitExceeded", "UsageLimitExceeded", { usageLimitExceeded: {} }]) {
    for (const [method, params] of [
      ["error", { willRetry: false, error: { message: "Quota reached", codexErrorInfo: code } }],
      ["turn/completed", { turn: { id: "t", status: "failed", error: { message: "Quota reached", codexErrorInfo: code } } }],
    ] as const) {
      const persisted = mapNotification("fixture", method, params, state()).map((event) => AgentEvent.parse(JSON.parse(JSON.stringify(event))));
      expect(persisted).toContainEqual(expect.objectContaining({ type: "activity.updated", recovery: { kind: "usage", provider: "codex" } }));
    }
  }
});
it("validates reset attempts and leaves legacy catalog reads valid", () => {
  expect(rpcParams["providers.codex.reset"].safeParse({ attemptId: "invalid", confirmationToken: "snapshot" }).success).toBe(false);
  expect(rpcParams["providers.codex.reset"].safeParse({ attemptId: "00000000-0000-4000-8000-000000000001", confirmationToken: "snapshot" }).success).toBe(true);
  expect(rpcParams["providers.codex.reset"].safeParse({ attemptId: "00000000-0000-4000-8000-000000000001" }).success).toBe(false);
  expect(rpcParams["agents.models"].parse({})).toEqual({});
  expect(rpcParams["agents.modelCatalog"].parse({ agent: "claude" })).toEqual({ agent: "claude" });
  expect(rpcParams["agents.models.refresh"].safeParse({ agent: "unknown" }).success).toBe(false);
});
it("does not confuse generic HTTP limits, network retries or error wording with quota exhaustion", () => {
  for (const params of [
    { willRetry: true, error: { message: "Retrying", codexErrorInfo: "usageLimitExceeded" } },
    { willRetry: false, error: { message: "Usage limit exceeded", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } },
    { willRetry: false, error: { message: "usageLimitExceeded" } },
  ])
    expect(JSON.stringify(mapNotification("fixture", "error", params, state()))).not.toContain('"recovery"');
});

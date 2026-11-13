import { expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentEvent, harnessIds } from "@openorc/protocol";
import { emitProviderFailure, providerErrorActivity } from "./provider-errors.js";

it.each(harnessIds)("keeps %s sign-in and limit recovery attached to that agent", (provider) => {
  const signedOut = providerErrorActivity("run", provider, "error", RequestError.authRequired());
  expect(AgentEvent.parse(signedOut)).toMatchObject({ recovery: { kind: "sign_in", provider } });
  const atLimit = providerErrorActivity("run", provider, "error", new Error("Your usage limit has been reached."));
  expect(AgentEvent.parse(atLimit)).toMatchObject({ recovery: { kind: "usage", provider } });
});

it.each(["429 Too many requests", "Overloaded", "Model unavailable", "Invalid API key", "Session expired", "Rate limit exceeded"])("does not guess an account diagnosis for %s", (message) => {
  expect(providerErrorActivity("run", "pi", "error", message)).toMatchObject({ text: message });
  expect(providerErrorActivity("run", "pi", "error", message).recovery).toBeUndefined();
});

it.each(["insufficient_quota", "Your credit balance is too low", "Quota exceeded", "Insufficient credits"])("offers usage settings for an explicit billing limit: %s", (message) => {
  expect(providerErrorActivity("run", "fx", "error", new Error(message)).recovery).toEqual({ kind: "usage", provider: "fx" });
});

it("offers recovery when authentication fails before the first turn", () => {
  const events: AgentEvent[] = [];
  emitProviderFailure((event) => events.push(AgentEvent.parse(event)), "run", "cursor", RequestError.authRequired());
  expect(events).toMatchObject([
    { type: "activity.updated", recovery: { kind: "sign_in", provider: "cursor" } },
    { type: "error", fatal: true },
  ]);
});

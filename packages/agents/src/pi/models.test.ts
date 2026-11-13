import { expect, it } from "vitest";
import { piAuthenticated, piModelsFrom } from "./models.js";

it("only claims readiness when Pi lists usable models", () => {
  expect(piAuthenticated("No models available. Use /login to log into a provider via OAuth or API key.")).toBe(false);
  expect(piAuthenticated("provider  model  context  max-out  thinking  images\nfixture   model  32k      1k       no        yes\n")).toBe(true);
  expect(piAuthenticated("Error: unable to read auth.json")).toBeNull();
});

it("keeps provider model IDs intact and respects Pi's supported thinking levels", () => {
  const model = { id: "vendor/model", provider: "openrouter", name: "Model", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "high", max: null } };
  const models = piModelsFrom({ models: [model] }, { sessionId: "session", model, thinkingLevel: "high" });
  expect(models).toMatchObject([
    { id: "openrouter/vendor/model", agent: "pi", provider: { id: "openrouter", label: "OpenRouter" }, efforts: ["off", "low", "medium", "high", "xhigh"], defaultEffort: "high", isDefault: true },
  ]);
  expect(() => piModelsFrom({ models: [{ id: 9 }] }, { sessionId: "session", thinkingLevel: "off" })).toThrow();
});

import { expect, it } from "vitest";
import { modelsFrom } from "./models.js";

it("preserves Cursor model variant IDs and labels while billing them to the Cursor account", () => {
  expect(
    modelsFrom([{ id: "model", name: "Model", type: "select", currentValue: "sonnet[thinking=true]", options: [{ value: "sonnet[thinking=true]", name: "Sonnet / Thinking" }] }], {
      id: "cursor",
      label: "Cursor account",
    }),
  ).toEqual([{ id: "sonnet[thinking=true]", label: "Sonnet / Thinking", provider: { id: "cursor", label: "Cursor account" }, isDefault: true }]);
});

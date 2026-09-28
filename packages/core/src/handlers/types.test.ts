import { describe, expect, it } from "vitest";
import { composeHandlers, type Handlers } from "./types.js";

// These calls intentionally cannot compile without their expected errors. This
// checks registration constraints even though an invalid map is harmless to construct.
function incompleteRegistration() {
  // @ts-expect-error Every RPC must be registered.
  return composeHandlers({});
}
function duplicateRegistration(handlers: Handlers) {
  // @ts-expect-error Repeating a key must fail even when both handlers have the same signature.
  return composeHandlers(handlers, { "system.info": handlers["system.info"] });
}

describe("RPC handler registration", () => {
  it("keeps completeness and uniqueness checked by TypeScript", () => {
    expect(incompleteRegistration()).toEqual({});
    expect(duplicateRegistration).toBeTypeOf("function");
  });
});

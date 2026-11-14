import { expect, it } from "vitest";
import { z } from "zod";
import { onlineTaskRpcParams } from "./online-tasks.js";
import { OWNER_SESSION_METHODS, ownerRoute } from "./owners.js";

it("keeps every online task call on the account-owning core, outside local task and brain routing", () => {
  for (const method of z.object(onlineTaskRpcParams).keyof().options) {
    expect(ownerRoute(method)).toEqual({ by: "here" });
    expect(OWNER_SESSION_METHODS.has(method)).toBe(false);
  }
});

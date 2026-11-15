import { expect, it } from "vitest";
import { z } from "zod";
import { onlineTaskRpcParams } from "./online-tasks.js";
import { ownerRoute } from "./owners.js";

it("keeps every online task call on the account-owning core, outside local task routing", () => {
  for (const method of z.object(onlineTaskRpcParams).keyof().options) {
    expect(ownerRoute(method)).toEqual({ by: "here" });
  }
});

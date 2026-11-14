import { expect, it } from "vitest";
import { OnlineTaskSendContext } from "./online-task-execution.js";

it("keeps task send references within the server's bounded id and safe revision", () => {
  expect(OnlineTaskSendContext.safeParse({ id: "a".repeat(128), ifRevision: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  for (const value of [{ id: "" }, { id: "a".repeat(129) }, { ifRevision: -1 }, { ifRevision: 0.5 }, { ifRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(OnlineTaskSendContext.safeParse({ id: "task", ifRevision: 0, ...value }).success).toBe(false);
  }
});

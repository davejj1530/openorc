import { expect, it, vi } from "vitest";
import { isRemoteMethod, onlineTaskExecutionRpcParams } from "@openorc/protocol";
import { createOnlineTaskExecutionHandlers } from "./handlers/online-task-execution.js";

const input = () => ({ spaceId: "team-space", id: "task", requestId: crypto.randomUUID(), ifRevision: 2 });
it("prepares through the captured online service with an unchanged request identity", async () => {
  const openThread = vi.fn().mockRejectedValue(new Error("Unavailable"));
  const handler = createOnlineTaskExecutionHandlers({ openThread });
  const request = input();
  await expect(handler["tasks.online.openThread"](request)).rejects.toThrow("Unavailable");
  expect(openThread).toHaveBeenCalledExactlyOnceWith(request);
  expect(() => createOnlineTaskExecutionHandlers(null)["tasks.online.openThread"](request)).toThrow("Online tasks aren't available here.");
});
it("requires an explicit space and revision and never makes preparation a phone method", () => {
  const schema = onlineTaskExecutionRpcParams["tasks.online.openThread"];
  const request = input();
  expect(schema.safeParse(request).success).toBe(true);
  expect(schema.safeParse({ ...request, spaceId: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...request, ifRevision: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...request, requestId: "different" }).success).toBe(false);
  expect(schema.safeParse({ ...request, payer: "someone-else" }).success).toBe(false);
  expect(isRemoteMethod("tasks.online.openThread")).toBe(false);
});

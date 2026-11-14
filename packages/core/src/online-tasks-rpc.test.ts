import { expect, it } from "vitest";
import { isRemoteMethod, onlineTaskRpcParams, rpcParams } from "@openorc/protocol";
import { createOnlineTaskHandlers } from "./handlers/online-tasks.js";

it("keeps online tasks unavailable without an account service and never falls through to a local task", () => {
  const handlers = createOnlineTaskHandlers(null);
  expect(handlers["tasks.online.state"]({ spaceId: "space" })).toEqual({ state: "unavailable" });
  expect(() => handlers["tasks.online.get"]({ spaceId: "space", id: "local-task" })).toThrow("Online tasks aren't available here.");
  expect(() => handlers["tasks.online.update"]({ spaceId: "space", id: "local-task", requestId: crypto.randomUUID(), ifRevision: 1, patch: { status: "done" } })).toThrow(
    "Online tasks aren't available here.",
  );
});
it("leaves the installed phone method allowlist unchanged", () => {
  for (const method of Object.keys(onlineTaskRpcParams)) expect(isRemoteMethod(method)).toBe(false);
  expect(isRemoteMethod("tasks.get")).toBe(true);
});
it("requires scope, revision and stable request IDs and refuses authority fields", () => {
  const input = { spaceId: "space", id: "task", requestId: crypto.randomUUID(), ifRevision: 2, patch: { spec: "Typed words" } };
  expect(rpcParams["tasks.online.update"].safeParse(input).success).toBe(true);
  expect(rpcParams["tasks.online.update"].safeParse({ ...input, ifRevision: undefined }).success).toBe(false);
  expect(rpcParams["tasks.online.update"].safeParse({ ...input, spaceId: undefined }).success).toBe(false);
  expect(rpcParams["tasks.online.update"].safeParse({ ...input, requestId: "not-a-uuid" }).success).toBe(false);
  expect(rpcParams["tasks.online.update"].safeParse({ ...input, actor: "another-person" }).success).toBe(false);
  expect(rpcParams["tasks.online.update"].safeParse({ ...input, patch: { payer: "another-person" } }).success).toBe(false);
  expect(rpcParams["tasks.update"].safeParse({ id: "local-task", patch: { spec: "Words" } }).success).toBe(true);
});

import { describe, expect, it } from "vitest";
import { hostedParityRpcParams } from "./hosted-parity.js";
import { isRemoteMethod } from "./remote.js";
import { ownerRoute } from "./owners.js";

describe("desktop review calls", () => {
  it("keeps the new methods outside the phone allowlist", () => {
    for (const method of Object.keys(hostedParityRpcParams)) expect(isRemoteMethod(method), method).toBe(false);
  });
  it("requires a stable action id and leaves older review inputs alone", () => {
    expect(hostedParityRpcParams["hosted.review.action"].safeParse({ threadId: "thread", action: { kind: "push" } }).success).toBe(false);
    expect(hostedParityRpcParams["hosted.review.action"].parse({ threadId: "thread", action: { kind: "push", id: "eeb80918-3595-4872-b846-f6c004abc5b1" } }).action.id).toBe(
      "eeb80918-3595-4872-b846-f6c004abc5b1",
    );
    expect(ownerRoute("hosted.review.changes")?.by).toBe("owner");
  });
});

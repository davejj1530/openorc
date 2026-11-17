import { describe, expect, it, vi } from "vitest";
import { PlaceRouter } from "./place-router.js";

describe("desktop cloud review routing", () => {
  it("never falls through to the Mac for a cloud-only review call", async () => {
    const next = vi.fn();
    const router = new PlaceRouter({ place: () => null, next });
    expect(await router.handle({ type: "rpc", id: 1, method: "hosted.review.changes", params: { threadId: "unavailable" } })).toMatchObject({ type: "rpc.error" });
    expect(next).not.toHaveBeenCalled();
  });
  it("keeps a local review request unchanged", async () => {
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 2, result: { baseSha: null, files: [], patch: "", since: null } }));
    const router = new PlaceRouter({ place: () => null, next });
    const request = { type: "rpc" as const, id: 2, method: "review.threadDiff", params: { threadId: "local-thread" } };
    await router.handle(request);
    expect(next).toHaveBeenCalledExactlyOnceWith(request);
  });
});

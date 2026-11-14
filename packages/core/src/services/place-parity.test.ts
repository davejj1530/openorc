import type { HostedThreads } from "@openorc/hosted";
import { describe, expect, it, vi } from "vitest";
import { PlaceRouter } from "./place-router.js";

const place: HostedThreads = {
  brain: "hosted",
  active: true,
  holds: (ref) => ("thread" in ref && ref.thread === "cloud-thread") || ("run" in ref && ref.run === "hosted:cloud-thread"),
  call: async () => {
    throw new Error("This cloud operation is unavailable.");
  },
  project: () => null,
  listed: () => null,
};

describe("hosted calls normally served here", () => {
  it.each([
    { method: "instructions.list", params: { threadId: "cloud-thread" } },
    { method: "instructions.save", params: { threadId: "cloud-thread", path: "AGENTS.md", content: "Example", version: null } },
    { method: "preview.state", params: { threadId: "cloud-thread" } },
    { method: "cloud.openOnMac", params: { threadId: "cloud-thread" } },
    { method: "cloud.closeOnMac", params: { threadId: "cloud-thread" } },
    { method: "cloud.bringToMac", params: { threadId: "cloud-thread" } },
    { method: "cloud.keep", params: { threadId: "cloud-thread" } },
    { method: "threads.snapshot", params: { threadId: "cloud-thread", known: [] } },
    { method: "mcpApps.open", params: { runId: "hosted:cloud-thread", toolCallId: "call-1" } },
  ])("never sends $method into the Mac for a known hosted thread", async ({ method, params }) => {
    const next = vi.fn();
    const router = new PlaceRouter({ place: () => place, next });
    expect(await router.handle({ type: "rpc", id: 1, method, params })).toMatchObject({ type: "rpc.error" });
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps local instructions and Preview on their existing path", async () => {
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 2, result: [] }));
    const router = new PlaceRouter({ place: () => place, next });
    for (const method of ["instructions.list", "preview.state"]) {
      const request = { type: "rpc" as const, id: 2, method, params: { threadId: "local-thread" } };
      await router.handle(request);
      expect(next).toHaveBeenLastCalledWith(request);
    }
  });
});

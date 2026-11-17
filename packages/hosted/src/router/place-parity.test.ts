import type { HostedThreads } from "../index.js";
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
  it("keeps a known cloud id out of the Mac after sign-out or loss of access", async () => {
    let current: HostedThreads | null = place;
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 3, result: null }));
    const router = new PlaceRouter({ place: () => current, next });
    const request = { type: "rpc" as const, id: 3, method: "instructions.list", params: { threadId: "cloud-thread" } };
    await router.handle(request);
    current = null;
    expect(await router.handle(request)).toMatchObject({ type: "rpc.error" });
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a cloud id go to this Mac once the thread came here by a move, keeping its id", async () => {
    let holds = true;
    const moved = new Set<string>();
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 3, result: null }));
    const router = new PlaceRouter({ place: () => ({ ...place, holds: (ref) => holds && place.holds(ref) }), next, movedHere: (id) => moved.has(id) });
    const request = { type: "rpc" as const, id: 3, method: "threads.get", params: { id: "cloud-thread" } };
    await router.handle(request);
    holds = false;
    expect(await router.handle(request)).toMatchObject({ type: "rpc.error", message: "That conversation isn't available on OpenOrc Cloud." });
    moved.add("cloud-thread");
    expect(await router.handle(request)).toMatchObject({ type: "rpc.result" });
    expect(next).toHaveBeenCalledTimes(1);
    // A run of the thread from its cloud days still never reaches this Mac.
    expect(await router.handle({ type: "rpc", id: 4, method: "events.page", params: { runId: "hosted:cloud-thread" } })).toMatchObject({ type: "rpc.error" });
  });

  it("asks this Mac a call the cloud failed because the thread moved here while it was on its way", async () => {
    let holds = true;
    const moved = new Set<string>();
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 5, result: { viewer: null, turnOf: {}, senders: {}, authors: {} } }));
    const leaving: HostedThreads = {
      ...place,
      holds: (ref) => holds && place.holds(ref),
      call: async () => {
        // The thread leaves the place, for this Mac, while the call is there.
        holds = false;
        moved.add("cloud-thread");
        throw new Error("That conversation isn't on OpenOrc Cloud.");
      },
    };
    const router = new PlaceRouter({ place: () => leaving, next, movedHere: (id) => moved.has(id) });
    expect(await router.handle({ type: "rpc", id: 5, method: "threads.authors", params: { threadId: "cloud-thread" } })).toMatchObject({ type: "rpc.result" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps the place's refusal for a thread that is still there, or went anywhere but this Mac", async () => {
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 6, result: null }));
    const router = new PlaceRouter({ place: () => place, next, movedHere: () => false });
    expect(await router.handle({ type: "rpc", id: 6, method: "threads.authors", params: { threadId: "cloud-thread" } })).toMatchObject({
      type: "rpc.error",
      message: "This cloud operation is unavailable.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("recognizes a hosted run even when its account is no longer active", async () => {
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 3, result: null }));
    const router = new PlaceRouter({ place: () => null, next });
    expect(await router.handle({ type: "rpc", id: 3, method: "events.toolOutput", params: { runId: "hosted:cloud-thread", toolCallId: "call-1" } })).toMatchObject({ type: "rpc.error" });
    expect(next).not.toHaveBeenCalled();
  });
  it.each([
    { method: "files.search", params: { scope: { kind: "thread", id: "cloud-thread" }, query: "example" } },
    { method: "files.read", params: { scope: { kind: "thread", id: "cloud-thread" }, path: "example.ts" } },
    { method: "files.list", params: { scope: { kind: "thread", id: "cloud-thread" }, path: "" } },
    { method: "instructions.list", params: { threadId: "cloud-thread" } },
    { method: "instructions.save", params: { threadId: "cloud-thread", path: "AGENTS.md", content: "Example", version: null } },
    { method: "preview.state", params: { threadId: "cloud-thread" } },
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

describe("message search with no space chosen", () => {
  const hit = (threadId: string, ts: number, runId: string) => ({
    threadId,
    threadTitle: "Example",
    projectId: "p",
    runId,
    messageId: `m-${ts}`,
    turn: 0,
    role: "user" as const,
    snippet: "Example",
    ts,
    taskId: null,
    taskTitle: null,
    member: null,
  });

  it("answers this Mac's hits and every cloud thread's, newest first, cut to the limit", async () => {
    const search = vi.fn(async () => [hit("cloud-thread", 30, "hosted:cloud-thread"), hit("cloud-thread", 10, "hosted:cloud-thread")]);
    const next = vi.fn(async () => ({ type: "rpc.result" as const, id: 4, result: [hit("local-thread", 20, "run-1")] }));
    const router = new PlaceRouter({ place: () => ({ ...place, search }), next });
    const reply = await router.handle({ type: "rpc", id: 4, method: "threads.search", params: { query: "example", limit: 2 } });
    expect(reply).toMatchObject({ type: "rpc.result", result: [{ messageId: "m-30" }, { messageId: "m-20" }] });
    expect(search).toHaveBeenCalledWith(undefined, { query: "example", limit: 2 });
  });

  it("says a cloud server's refusal rather than this Mac's hits alone", async () => {
    const search = vi.fn(async () => Promise.reject(new Error("Searching this cloud thread's full history isn't available yet.")));
    const router = new PlaceRouter({ place: () => ({ ...place, search }), next: vi.fn(async () => ({ type: "rpc.result" as const, id: 5, result: [] })) });
    expect(await router.handle({ type: "rpc", id: 5, method: "threads.search", params: { query: "example" } })).toMatchObject({
      type: "rpc.error",
      message: "Searching this cloud thread's full history isn't available yet.",
    });
  });
});

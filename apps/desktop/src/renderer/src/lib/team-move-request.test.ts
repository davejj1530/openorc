import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginTeamMoveCancellation, beginTeamMoveRequest, finishTeamMoveRequest, pendingTeamMove, readTeamMoveRequest, teamMoveStorageKey } from "./team-move-request";

describe("durable team workspace moves", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("replays the same destination after an uncertain reply without silently changing it", () => {
    const request = beginTeamMoveRequest("source", "current", undefined, () => "move-1");
    expect(request).toEqual({ requestKey: "move-1", to: "current", phase: "move" });
    expect(beginTeamMoveRequest("source", "current", undefined, () => "duplicate")).toEqual(request);
    expect(() => beginTeamMoveRequest("source", "worktree")).toThrow("another destination needs confirmation");
    expect(beginTeamMoveRequest("other", "worktree", undefined, () => "separate").requestKey).toBe("separate");
    expect(readTeamMoveRequest("source")).toEqual(request);
  });

  it("requires confirmed server admission before offering a first cancellation", () => {
    expect(() => beginTeamMoveCancellation("source")).toThrow("server has not confirmed");
    const request = beginTeamMoveRequest("source", "current", undefined, () => "known-local");
    expect(() => beginTeamMoveCancellation("source")).toThrow("server has not confirmed");
    expect(readTeamMoveRequest("source")).toEqual(request);
    expect(beginTeamMoveCancellation("source", { requestKey: request.requestKey, to: request.to, cancelRequested: false })).toEqual({ ...request, phase: "cancel" });
  });

  it("replays cancellation after reload, stale reports, and loss of a terminal cancellation reply", () => {
    const recovery = { requestKey: "accepted", to: "worktree" as const, cancelRequested: false };
    const request = beginTeamMoveCancellation("source", recovery);
    expect(readTeamMoveRequest("source")).toEqual(request);
    expect(pendingTeamMove(request, recovery)).toEqual(request);
    expect(beginTeamMoveCancellation("source")).toEqual(request);
    expect(beginTeamMoveCancellation("source", recovery)).toEqual(request);
    expect(() => beginTeamMoveRequest("source", "worktree", recovery)).toThrow("saved cancellation request");
    expect(() => beginTeamMoveRequest("source", "worktree")).toThrow("saved cancellation request");
  });

  it("lets authoritative recovery replace stale local identity while retaining its exact destination and phase", () => {
    const old = beginTeamMoveRequest("source", "current", undefined, () => "old");
    const recovery = { requestKey: "accepted-elsewhere", to: "worktree" as const, cancelRequested: true };
    expect(pendingTeamMove(old, recovery)).toEqual({ requestKey: recovery.requestKey, to: "worktree", phase: "cancel" });
    expect(beginTeamMoveCancellation("source", recovery)).toEqual({ requestKey: recovery.requestKey, to: "worktree", phase: "cancel" });
    expect(finishTeamMoveRequest("source", old)).toBe(true);
    expect(readTeamMoveRequest("source")?.requestKey).toBe(recovery.requestKey);
  });

  it("does not erase a later cancellation intention when the original move acknowledgement arrives", () => {
    const moved = beginTeamMoveRequest("source", "current", undefined, () => "accepted");
    const cancelled = beginTeamMoveCancellation("source", { ...moved, cancelRequested: false });
    expect(finishTeamMoveRequest("source", moved)).toBe(true);
    expect(readTeamMoveRequest("source")).toEqual(cancelled);
    expect(finishTeamMoveRequest("source", cancelled)).toBe(true);
    expect(readTeamMoveRequest("source")).toBeNull();
  });

  it("retains corrupt records unless authoritative recovery identifies the accepted operation", () => {
    storage.set(teamMoveStorageKey("source"), "{bad");
    expect(() => beginTeamMoveRequest("source", "current")).toThrow("retained to protect the workspace");
    expect(() => beginTeamMoveCancellation("source")).toThrow("retained to protect the workspace");
    const recovery = { requestKey: "accepted", to: "current" as const, cancelRequested: false };
    expect(beginTeamMoveRequest("source", "worktree", recovery)).toEqual({ requestKey: "accepted", to: "current", phase: "move" });
  });

  it("never sends an unpersisted phase change and retains its envelope if local confirmation fails", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("full");
    });
    expect(() => beginTeamMoveRequest("source", "current")).toThrow("no request was sent");
    expect(readTeamMoveRequest("source")).toBeNull();
    const moved = beginTeamMoveRequest("source", "current", undefined, () => "accepted");
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("full");
    });
    expect(() => beginTeamMoveCancellation("source", { ...moved, cancelRequested: false })).toThrow("no request was sent");
    expect(readTeamMoveRequest("source")).toEqual(moved);
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw new Error("full");
    });
    expect(finishTeamMoveRequest("source", moved)).toBe(false);
    expect(beginTeamMoveRequest("source", "current")).toEqual(moved);
  });
});

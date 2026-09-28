import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginTeamRestoreRequest, finishTeamRestoreRequest, readTeamRestoreRequest, teamRestoreStorageKey } from "./team-restore-request";

describe("durable team checkpoint restore", () => {
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

  it("replays an uncertain restore after reload without changing the captured checkpoint", () => {
    const request = beginTeamRestoreRequest("thread", "checkpoint", undefined, () => "original");
    expect(readTeamRestoreRequest("thread")).toEqual(request);
    expect(beginTeamRestoreRequest("thread", "checkpoint", undefined, () => "duplicate")).toEqual(request);
    expect(() => beginTeamRestoreRequest("thread", "different")).toThrow("another checkpoint needs confirmation");
    expect(readTeamRestoreRequest("thread")).toEqual(request);
    expect(beginTeamRestoreRequest("other-thread", "different", undefined, () => "separate").requestKey).toBe("separate");
    expect(finishTeamRestoreRequest("thread", request)).toBe(true);
    expect(beginTeamRestoreRequest("thread", "different", undefined, () => "next")).toEqual({ requestKey: "next", checkpointId: "different" });
  });

  it("uses the server recovery's exact checkpoint and preserves another window's later request", () => {
    const old = beginTeamRestoreRequest("thread", "old", undefined, () => "old-key");
    const recovery = { requestKey: "server-key", checkpointId: "server-checkpoint" };
    expect(beginTeamRestoreRequest("thread", "local-selection", recovery)).toEqual(recovery);
    expect(finishTeamRestoreRequest("thread", old)).toBe(true);
    expect(readTeamRestoreRequest("thread")).toEqual(recovery);
    expect(finishTeamRestoreRequest("thread", recovery)).toBe(true);
    expect(finishTeamRestoreRequest("thread", recovery)).toBe(true);
  });

  it("blocks unrecorded or corrupted requests, with authoritative recovery as the only replacement", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw Error("full");
    });
    expect(() => beginTeamRestoreRequest("thread", "checkpoint")).toThrow("no restore was requested");
    expect(readTeamRestoreRequest("thread")).toBeNull();
    storage.set(teamRestoreStorageKey("thread"), JSON.stringify({ requestKey: "accepted", checkpointId: null }));
    expect(() => beginTeamRestoreRequest("thread", "checkpoint")).toThrow("retained to prevent a duplicate");
    const recovery = { requestKey: "accepted", checkpointId: "original-checkpoint" };
    expect(beginTeamRestoreRequest("thread", "checkpoint", recovery)).toEqual(recovery);
  });

  it("retains the exact request when local acknowledgment fails after successful restore", () => {
    const request = beginTeamRestoreRequest("thread", "checkpoint", undefined, () => "accepted");
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw Error("unavailable");
    });
    expect(finishTeamRestoreRequest("thread", request)).toBe(false);
    expect(beginTeamRestoreRequest("thread", "checkpoint", undefined, () => "duplicate")).toEqual(request);
  });
});

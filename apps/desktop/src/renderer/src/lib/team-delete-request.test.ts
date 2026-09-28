import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginTeamDeleteRequest, finishTeamDeleteRequest, readTeamDeleteRequest, teamDeleteStorageKey } from "./team-delete-request";

describe("durable team conversation delete", () => {
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

  it("replays the same key after an uncertain reply and starts fresh once acknowledged", () => {
    const request = beginTeamDeleteRequest("thread", undefined, () => "original");
    expect(storage.get(teamDeleteStorageKey("thread"))).toBe(JSON.stringify(request));
    expect(readTeamDeleteRequest("thread")).toEqual(request);
    expect(beginTeamDeleteRequest("thread", undefined, () => "duplicate")).toEqual(request);
    expect(beginTeamDeleteRequest("other", undefined, () => "separate").requestKey).toBe("separate");
    expect(finishTeamDeleteRequest("thread", request)).toBe(true);
    expect(readTeamDeleteRequest("thread")).toBeNull();
    expect(beginTeamDeleteRequest("thread", undefined, () => "next").requestKey).toBe("next");
  });

  it("prefers the server's retained request over a local key and replaces corrupted state with it", () => {
    beginTeamDeleteRequest("thread", undefined, () => "local");
    const recovery = { requestKey: "server-key", error: "Cleanup was interrupted." };
    expect(beginTeamDeleteRequest("thread", recovery)).toEqual({ requestKey: "server-key" });
    expect(readTeamDeleteRequest("thread")).toEqual({ requestKey: "server-key" });
    storage.set(teamDeleteStorageKey("thread"), JSON.stringify({ requestKey: 12 }));
    expect(() => beginTeamDeleteRequest("thread")).toThrow("retained to prevent a repeated deletion");
    expect(beginTeamDeleteRequest("thread", recovery)).toEqual({ requestKey: "server-key" });
  });

  it("never records a request it could not persist", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw Error("full");
    });
    expect(() => beginTeamDeleteRequest("thread")).toThrow("nothing was deleted");
    expect(readTeamDeleteRequest("thread")).toBeNull();
  });

  it("keeps the exact request when acknowledgment fails and ignores a stale acknowledgment", () => {
    const request = beginTeamDeleteRequest("thread", undefined, () => "accepted");
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw Error("unavailable");
    });
    expect(finishTeamDeleteRequest("thread", request)).toBe(false);
    expect(readTeamDeleteRequest("thread")).toEqual(request);
    expect(finishTeamDeleteRequest("thread", { requestKey: "older" })).toBe(true);
    expect(readTeamDeleteRequest("thread")).toEqual(request);
  });
});

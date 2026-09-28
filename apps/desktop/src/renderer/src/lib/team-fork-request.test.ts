import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginTeamForkRequest, finishTeamForkRequest, readTeamForkRequest, teamForkRequestChanged, teamForkStorageKey } from "./team-fork-request";

describe("durable team forks", () => {
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

  it("replays the same full-thread request after an uncertain response and isolates another source", () => {
    const request = beginTeamForkRequest("source", undefined, () => "first");
    expect(request).toEqual({ requestKey: "first", upToRunId: null });
    expect(readTeamForkRequest("source")).toEqual(request);
    expect(beginTeamForkRequest("source", undefined, () => "duplicate")).toEqual(request);
    expect(beginTeamForkRequest("other", undefined, () => "independent").requestKey).toBe("independent");
    expect(finishTeamForkRequest("source", request)).toBe(true);
    expect(beginTeamForkRequest("source", undefined, () => "intentional-next").requestKey).toBe("intentional-next");
  });

  it("adopts the server's exact retained cutoff rather than the current local request", () => {
    const local = beginTeamForkRequest("source", undefined, () => "local");
    const recovered = { requestKey: "accepted-elsewhere", upToRunId: "original-run" };
    expect(beginTeamForkRequest("source", { recovery: recovered })).toEqual(recovered);
    expect(readTeamForkRequest("source")).toEqual(recovered);
    expect(finishTeamForkRequest("source", local)).toBe(true);
    expect(readTeamForkRequest("source")).toEqual(recovered);
    expect(finishTeamForkRequest("source", recovered)).toBe(true);
    expect(finishTeamForkRequest("source", recovered)).toBe(true);
    expect(readTeamForkRequest("source")).toBeNull();
  });

  it("never sends an unpersisted request or replaces malformed local state without authoritative recovery", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw Error("full");
    });
    expect(() => beginTeamForkRequest("source", undefined, () => "not-saved")).toThrow("no fork was requested");
    expect(readTeamForkRequest("source")).toBeNull();
    storage.set(teamForkStorageKey("source"), "{broken");
    expect(() => beginTeamForkRequest("source")).toThrow("retained to prevent a duplicate");
    const recovered = { requestKey: "server-recovery", upToRunId: null };
    expect(beginTeamForkRequest("source", { recovery: recovered })).toEqual(recovered);
  });

  it("keeps the accepted request for safe retry when local confirmation fails", () => {
    const request = beginTeamForkRequest("source", undefined, () => "accepted");
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw Error("unavailable");
    });
    expect(finishTeamForkRequest("source", request)).toBe(false);
    expect(beginTeamForkRequest("source", undefined, () => "duplicate")).toEqual(request);
  });

  it("never silently replaces a clicked reply with a different server recovery", () => {
    const local = beginTeamForkRequest("source", { upToRunId: "lead-run-1" }, () => "local");
    const recovery = { requestKey: "server", upToRunId: "lead-run-2" };
    expect(() => beginTeamForkRequest("source", { recovery, upToRunId: "lead-run-1" })).toThrow("another point needs confirmation");
    expect(readTeamForkRequest("source")).toEqual(local);
    expect(beginTeamForkRequest("source", { recovery })).toEqual(recovery);
    expect(beginTeamForkRequest("source", { recovery, upToRunId: "lead-run-2" })).toEqual(recovery);
  });

  it("updates another mounted control only after the shared recovery record changes", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    target.addEventListener(teamForkRequestChanged, (event) => {
      const id = (event as CustomEvent<string>).detail;
      seen.push([id, readTeamForkRequest(id)]);
    });
    const request = beginTeamForkRequest("source", { upToRunId: "lead-run" }, () => "shared");
    expect(seen).toEqual([["source", request]]);
    expect(finishTeamForkRequest("source", request)).toBe(true);
    expect(seen).toEqual([
      ["source", request],
      ["source", null],
    ]);
  });
});

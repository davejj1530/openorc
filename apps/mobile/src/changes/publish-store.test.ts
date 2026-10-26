import { describe, expect, it, vi } from "vitest";
import { createPublishStore } from "./publish-store";

const DROPPED = "The connection to your Mac dropped before it answered.";

function setup() {
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => saved.delete(key) };
  const haptic = { confirm: vi.fn(), fail: vi.fn() };
  const deps = { storage, macId: () => "mac-1", dropped: (error: Error) => error.message === DROPPED, haptic, now: () => 1000 };
  return { saved, haptic, deps, store: createPublishStore(deps) };
}

describe("publish store", () => {
  it("runs a write, then holds what it did with a confirm", async () => {
    const { store, haptic, saved } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    let answer!: (value: { sha: string }) => void;
    const done = store.run<{ sha: string }>(
      "t1",
      { action: "commit", message: "Fix", headBefore: "a" },
      () => new Promise((resolve) => (answer = resolve)),
      (r) => `Committed ${r.sha}`,
    );
    expect(store.get("t1")).toEqual({ kind: "running", action: "commit" });
    expect(saved.get("publish.mac-1.t1")).toBe(JSON.stringify({ action: "commit", message: "Fix", headBefore: "a" }));
    answer({ sha: "b2c3d4e" });
    await expect(done).resolves.toEqual({ sha: "b2c3d4e" });
    expect(store.get("t1")).toEqual({ kind: "notice", action: "commit", text: "Committed b2c3d4e", tone: "muted", details: null });
    expect(saved.size).toBe(0);
    expect(haptic.confirm).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get("t2")).toEqual({ kind: "idle" });
  });

  it("keeps a refusal's full text for Details, with a fail", async () => {
    const { store, haptic } = setup();
    const result = await store.run(
      "t1",
      { action: "push" },
      () => Promise.reject(new Error("origin has newer commits on feat/x.")),
      () => "Pushed",
    );
    expect(result).toBeNull();
    expect(store.get("t1")).toEqual({ kind: "notice", action: "push", text: "origin has newer commits on feat/x.", tone: "bad", details: "origin has newer commits on feat/x." });
    expect(haptic.fail).toHaveBeenCalledOnce();
  });

  it("never sends a dropped write again: it waits, kept on the phone, for reads to settle it", async () => {
    const { deps, saved, haptic } = setup();
    let clock = 1000;
    const store = createPublishStore({ ...deps, now: () => clock });
    clock = 2000;
    await store.run(
      "t1",
      { action: "pr" },
      () => Promise.reject(new Error(DROPPED)),
      () => "Opened",
    );
    expect(store.get("t1")).toEqual({ kind: "lost", lost: { action: "pr" } });
    // Only reads made after the loss can say what it did.
    expect(store.lostAt("t1")).toBe(2000);
    // The app was killed: a new store finds the write still out, and every read the new app makes came after it.
    const relaunched = createPublishStore({ ...deps, now: () => 5000 });
    expect(relaunched.get("t1")).toEqual({ kind: "lost", lost: { action: "pr" } });
    expect(relaunched.lostAt("t1")).toBe(0);
    relaunched.settle("t1", { kind: "done", notice: "Opened pull request #3" });
    expect(relaunched.get("t1")).toEqual({ kind: "notice", action: "pr", text: "Opened pull request #3", tone: "muted", details: null });
    expect(saved.size).toBe(0);
    expect(haptic.confirm).toHaveBeenCalledOnce();
    await store.run(
      "t2",
      { action: "push" },
      () => Promise.reject(new Error(DROPPED)),
      () => "Pushed",
    );
    store.settle("t2", { kind: "not-done" });
    expect(store.get("t2")).toEqual({ kind: "idle" });
  });

  it("lets go of every write it holds on reset, as a fresh install has", async () => {
    const { store } = setup();
    await store.run(
      "t1",
      { action: "push" },
      () => Promise.resolve(null),
      () => "Pushed main to origin",
    );
    expect(store.get("t1").kind).toBe("notice");
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(store.get("t1")).toEqual({ kind: "idle" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not start a second write while one is out, and drops a notice on clear", async () => {
    const { store } = setup();
    const write = vi.fn(() => new Promise<never>(() => undefined));
    void store.run("t1", { action: "push" }, write, () => "");
    expect(await store.run("t1", { action: "pr" }, write, () => "")).toBeNull();
    expect(write).toHaveBeenCalledOnce();
    await store.run(
      "t2",
      { action: "push" },
      () => Promise.reject(new Error("no")),
      () => "",
    );
    store.clear("t2");
    expect(store.get("t2")).toEqual({ kind: "idle" });
  });
});

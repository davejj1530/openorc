import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceWriters } from "./workspace-writers.js";

let directory: string;
let writers: WorkspaceWriters;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-writers-")));
  writers = new WorkspaceWriters();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("physical workspace reservations", () => {
  it("rejects aliases, ancestors, and descendants while allowing independent worktrees", async () => {
    const root = path.join(directory, "checkout");
    const alias = path.join(directory, "alias");
    await mkdir(root);
    await symlink(root, alias);
    const lease = await writers.acquire(root, "the lead run");
    for (const target of [root, alias, directory, path.join(alias, "missing", "nested")]) {
      await expect(writers.acquire(target, "another writer")).rejects.toThrow(/in use by the lead run/);
    }
    const independent = await writers.acquire(path.join(directory, "other-worktree"), "a worker");
    independent.release();
    lease.release();
    const next = await writers.acquire(alias, "next writer");
    expect(next.paths).toEqual([root]);
    next.release();
  });

  it("claims multiple paths atomically and never retains a partial claim after conflict", async () => {
    const first = path.join(directory, "a");
    const second = path.join(directory, "b");
    const occupied = await writers.acquire(second, "existing writer");
    await expect(writers.acquire([first, second], "move")).rejects.toThrow(/existing writer/);
    const free = await writers.acquire(first, "unrelated work");
    free.release();
    occupied.release();
    const contenders = await Promise.allSettled([writers.acquire([first, second], "move one"), writers.acquire([second, first], "move two")]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of contenders) if (result.status === "fulfilled") result.value.release();
  });

  it("retains an inherited writer after its setup holder releases and rejects stale or uncovered inheritance", async () => {
    const root = path.join(directory, "new-worktree");
    const setup = await writers.acquire(root, "setup then run");
    await mkdir(root);
    const run = await writers.acquire(root, "provider run", setup);
    setup.release();
    setup.release();
    await expect(writers.acquire(root, "review commit")).rejects.toThrow(/setup then run/);
    await expect(writers.acquire(root, "stale inheritance", setup)).rejects.toThrow(/released/);
    await expect(writers.acquire(directory, "wider mutation", run)).rejects.toThrow(/does not cover/);
    await expect(new WorkspaceWriters().acquire(root, "other host", run)).rejects.toThrow(/another host/);
    run.release();
    const next = await writers.acquire(root, "review commit");
    next.release();
  });

  it("releases awaited mutations on failure, but not a retained inherited run", async () => {
    await expect(
      writers.withLease(directory, "failing operation", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    const lease = await writers.acquire(directory, "parent");
    await expect(
      writers.withLease(
        directory,
        "nested operation",
        async () => {
          throw new Error("failed");
        },
        lease,
      ),
    ).rejects.toThrow("failed");
    await expect(writers.acquire(directory, "other")).rejects.toThrow(/parent/);
    lease.release();
    await writers.withLease(directory, "next", async () => {});
  });

  it("lets a shared holder join after a short exclusive operation, and aborts that wait on demand", async () => {
    const shared = path.join(directory, "team");
    await mkdir(shared);
    const members = await writers.acquire(shared, "run one", undefined, { shared: true });
    // Exclusive work on a shared workspace waits for the members' turns, as before.
    let waits = 0;
    const capture = writers.acquire(shared, "Capture team output lead", undefined, {
      shared: false,
      waitForShared: () => {
        waits += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    members.release();
    const captured = await capture;
    expect(waits).toBeGreaterThan(0);

    // A member joining while that capture holds the workspace waits for it instead of failing to start.
    const joining = writers.acquire(shared, "run two", undefined, { shared: true, waitForExclusive: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 250));
    captured.release();
    const joined = await joining;
    expect(joined.owner).toBe("run two");
    joined.release();

    // Without the option the same start still fails fast, and an aborting member stops waiting.
    const holder = await writers.acquire(shared, "Capture team output lead", undefined, { shared: false });
    await expect(writers.acquire(shared, "run three", undefined, { shared: true })).rejects.toThrow(/in use by Capture team output lead/);
    await expect(
      writers.acquire(shared, "run four", undefined, {
        shared: true,
        waitForExclusive: () => {
          throw new Error("This execution was stopped.");
        },
      }),
    ).rejects.toThrow(/was stopped/);
    holder.release();
  });

  it("rejects dangling symlinks instead of guessing a physical workspace", async () => {
    await symlink(path.join(directory, "absent"), path.join(directory, "dangling"));
    await expect(writers.acquire(path.join(directory, "dangling", "worktree"), "setup")).rejects.toThrow(/cannot be resolved/);
  });
});

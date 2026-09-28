import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWriters } from "./workspace-writers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(realpath).mockClear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("workspace paths created during reservation", () => {
  it.each(["symlink"])("resolves a %s created after the first realpath misses", async (kind) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-writer-race-")));
    directories.push(root);
    const workspace = path.join(root, "worktrees");
    const physical = kind === "symlink" ? path.join(root, "physical") : workspace;
    if (kind === "symlink") await mkdir(physical);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(realpath).mockImplementationOnce(async (input) => {
      expect(input).toBe(workspace);
      try {
        return await actual.realpath(input);
      } catch (error) {
        expect(error).toMatchObject({ code: "ENOENT" });
        if (kind === "symlink") await symlink(physical, workspace);
        else await mkdir(workspace);
        throw error;
      }
    });

    const writers = new WorkspaceWriters();
    const lease = await writers.acquire(workspace, "first launch");
    expect(lease.paths).toEqual([physical]);
    await expect(writers.acquire(path.join(physical, "child"), "overlapping launch")).rejects.toThrow(/in use by first launch/);
    lease.release();
    await expect(writers.reason([workspace])).resolves.toBeNull();
  });
});

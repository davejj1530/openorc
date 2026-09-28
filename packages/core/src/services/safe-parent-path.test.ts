import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSafeParentPath } from "./safe-parent-path.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openorc-parent-path-"));
  temporary.push(root);
  return root;
}

it("accepts a missing parent for creation, then rejects a symlink parent", async () => {
  const root = await workspace();
  const outside = await workspace();
  const directories = new Map<string, string>();
  await assertSafeParentPath(root, "nested/output.txt", directories);
  await symlink(outside, path.join(root, "nested"));
  await expect(assertSafeParentPath(root, "nested/output.txt", directories)).rejects.toThrow(/Unsafe parent directory/);
});

it("rejects a parent replaced after its identity was recorded", async () => {
  const root = await workspace();
  await mkdir(path.join(root, "nested"));
  const directories = new Map<string, string>();
  await assertSafeParentPath(root, "nested/output.txt", directories);
  await rename(path.join(root, "nested"), path.join(root, "old-nested"));
  await mkdir(path.join(root, "nested"));
  await expect(assertSafeParentPath(root, "nested/output.txt", directories)).rejects.toThrow(/Parent directory changed/);
});

it.each(["../outside.txt", "nested//output.txt", "nested/./output.txt", ".git/config"])('rejects unsafe relative path "%s"', async (file) => {
  await expect(assertSafeParentPath(await workspace(), file, new Map())).rejects.toThrow(/Unsafe path/);
});

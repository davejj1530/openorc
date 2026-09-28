import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileService } from "./files.js";

let dir: string;
let root: string;
const files = new FileService();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openorc-files-"));
  root = join(dir, "workspace");
  await mkdir(root);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("reads current UTF-8 contents through absolute, relative and internal symlink paths", async () => {
  const path = join(root, "Conversation.tsx");
  await writeFile(path, "export const message = 'hello';\n");
  expect((await files.read(root, "Conversation.tsx")).content).toContain("hello");
  await writeFile(path, "// unsaved-to-git change ✓\n");
  expect((await files.read(root, path)).content).toContain("change ✓");
  await symlink(path, join(root, "alias.tsx"));
  expect((await files.read(root, "alias.tsx")).content).toContain("change ✓");
});

it("rejects traversal and symlinks outside the selected workspace", async () => {
  const outside = join(dir, "outside.ts");
  await writeFile(outside, "outside");
  await symlink(outside, join(root, "outside-link.ts"));
  for (const path of [outside, "../outside.ts", "outside-link.ts"]) await expect(files.read(root, path)).rejects.toThrow("outside");
});

it("reports missing, folder, binary, non-UTF-8 and oversized files without sending their contents", async () => {
  await expect(files.read(root, "missing.ts")).rejects.toThrow("File not found");
  await expect(files.read(root, ".")).rejects.toThrow("folder");
  await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]));
  await expect(files.read(root, "binary")).rejects.toThrow("binary");
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await expect(files.read(root, "invalid")).rejects.toThrow("UTF-8");
  await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(files.read(root, "large")).rejects.toThrow("too large");
});

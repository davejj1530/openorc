import { mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FolderPath } from "@openorc/protocol";
import { FileFormatter } from "./file-format.js";
import { verifyFileUrl } from "./file-url.js";
import { FileService } from "./files.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let dir: string;
let root: string;
let writers: WorkspaceWriters;
let files: FileService;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "openorc-files-")));
  root = join(dir, "workspace");
  await mkdir(root);
  writers = new WorkspaceWriters();
  const formatter = new FileFormatter({ bundled: null, environment: () => ({ path: join(dir, "bin"), env: { PATH: "/usr/bin:/bin" } }), timeoutMs: 500 });
  files = new FileService({ writers, invalidate: () => {}, formatter, fileKey: "test-key" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const folder = () => ({ root, readOnly: null });
/** An empty file grown to `size` without writing it: it reads as NUL bytes. */
async function sparse(name: string, size: number): Promise<string> {
  const file = join(root, name);
  await writeFile(file, "");
  await truncate(file, size);
  return file;
}

it("shows known media by extension at any size, with a URL only the key names a path from, without reading the bytes", async () => {
  const image = await sparse("big.PNG", 3 * 1024 * 1024);
  const read = await files.read(folder(), "big.PNG");
  expect(read).toEqual({ kind: "binary", root, path: "big.PNG", absolutePath: image, size: 3 * 1024 * 1024, media: "image", mime: "image/png", url: expect.any(String) });
  if (read.kind !== "binary") throw new Error("not binary");
  expect(verifyFileUrl("test-key", read.url)).toBe(image);
  expect(verifyFileUrl("other-key", read.url)).toBeNull();
  await writeFile(join(root, "deck.pdf"), "%PDF-1.4 text only");
  expect(await files.read(folder(), "deck.pdf")).toMatchObject({ kind: "binary", media: "pdf", mime: "application/pdf", size: 18 });
});

it("hands out a new viewer URL once a file's bytes change, so the panel reloads it", async () => {
  await writeFile(join(root, "chart.png"), "v1");
  const first = await files.read(folder(), "chart.png");
  await writeFile(join(root, "chart.png"), "v2, longer");
  const second = await files.read(folder(), "chart.png");
  if (first.kind !== "binary" || second.kind !== "binary") throw new Error("not binary");
  expect(second.url).not.toBe(first.url);
  expect(verifyFileUrl("test-key", second.url)).toBe(first.absolutePath);
});

it("takes a NUL byte as binary of no particular kind, whether in the first bytes of a huge file or late in a small one", async () => {
  await sparse("blob.bin", 3 * 1024 * 1024);
  expect(await files.read(folder(), "blob.bin")).toMatchObject({ kind: "binary", media: "other", mime: "application/octet-stream", size: 3 * 1024 * 1024 });
  await writeFile(join(root, "late.dat"), Buffer.concat([Buffer.alloc(10_000, "a"), Buffer.from([0]), Buffer.alloc(10, "b")]));
  expect(await files.read(folder(), "late.dat")).toMatchObject({ kind: "binary", media: "other", size: 10_011 });
});

it("still reads text as text, refuses oversized text, and says what a folder or non-UTF-8 file is", async () => {
  await writeFile(join(root, "notes.txt"), "plain\n");
  expect(await files.read(folder(), "notes.txt")).toMatchObject({ kind: "file", text: "plain\n" });
  await writeFile(join(root, "dump.sql"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
  expect(await files.read(folder(), "dump.sql")).toMatchObject({ kind: "unreadable", reason: "This file is too large to open (2 MB maximum)." });
  await writeFile(join(root, "latin1.txt"), Buffer.from("café", "latin1"));
  expect(await files.read(folder(), "latin1.txt")).toMatchObject({ kind: "unreadable", reason: "This file is not UTF-8 text and cannot be shown." });
  await mkdir(join(root, "src"));
  expect(await files.read(folder(), "src")).toMatchObject({ kind: "unreadable", reason: "This path is a folder, not a file." });
});

it("refuses media outside the folder before it looks at the extension, through a symlink or by absolute path", async () => {
  const outside = join(dir, "secret.png");
  await writeFile(outside, Buffer.from([0x89, 0x50]));
  await symlink(outside, join(root, "link.png"));
  await expect(files.read(folder(), "link.png")).rejects.toThrow("outside the conversation's workspace");
  await expect(files.read(folder(), outside)).rejects.toThrow("outside the conversation's workspace");
});

it("offers a folder's files without git, skipping hidden entries and dependency or build output", async () => {
  for (const folder of ["src", ".cache", "node_modules/lib", "dist"]) await mkdir(join(root, folder), { recursive: true });
  for (const file of ["plan.md", "src/app.ts", ".env", ".cache/entry", "node_modules/lib/index.js", "dist/app.js"]) await writeFile(join(root, file), "x");
  const project = {
    id: "plain",
    name: "workspace",
    rootPath: root,
    gitRemote: null,
    defaultBranch: null,
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
    createdAt: 0,
    updatedAt: 0,
  };
  expect((await files.search({ root, project }, "")).sort()).toEqual(["plan.md", "src/app.ts"]);
  expect(await files.search({ root, project }, "app")).toEqual(["src/app.ts"]);
});

const absent = { kind: "absent" as const };
const editable = () => ({ root, readOnly: null, kind: "checkout" as const });
const saving = (path: string, text: string) => ({ path: FolderPath.parse(path), text, expected: absent, format: true });

it("refuses to write in a folder the resolver marked read-only, and writes nothing there", async () => {
  await expect(files.write({ root, readOnly: "Pull request copies are read-only.", kind: "review" }, saving("notes.md", "x"))).rejects.toThrow("Pull request copies are read-only.");
  await expect(readFile(join(root, "notes.md"))).rejects.toThrow();
});

it("stops a formatter that hangs at the timeout and saves the text as typed, saying why", async () => {
  await writeFile(join(root, "go.mod"), "module example.com/app\n");
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "gofmt"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  const saved = await files.write(editable(), saving("main.go", "package main\n"));
  expect(saved).toMatchObject({ kind: "saved", text: null, formatError: "gofmt: it took longer than 0.5 seconds and was stopped" });
  expect(await readFile(join(root, "main.go"), "utf8")).toBe("package main\n");
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("waits for an exclusive operation on the folder to finish instead of racing it, without asking idle agents to yield", async () => {
  let yields = 0;
  writers.onConflict(async () => {
    yields += 1;
    return false;
  });
  const commit = await writers.acquire(root, "committing");
  let settled = false;
  const pending = files.write(editable(), saving("notes.md", "written after the commit\n")).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(settled).toBe(false);
  commit.release();
  await expect(pending).resolves.toMatchObject({ kind: "saved" });
  expect(await readFile(join(root, "notes.md"), "utf8")).toBe("written after the commit\n");
  expect(yields).toBe(0);
});

it("saves beside an agent's shared lease without waiting, and gives up on an exclusive one held past the save wait", async () => {
  const run = await writers.acquire(root, "run", undefined, { shared: true });
  await expect(files.write(editable(), saving("beside.md", "x"))).resolves.toMatchObject({ kind: "saved" });
  run.release();
  const restore = await writers.acquire(root, "restoring");
  await expect(files.write(editable(), saving("blocked.md", "x"))).rejects.toThrow(/in use by restoring/);
  restore.release();
  await expect(readFile(join(root, "blocked.md"))).rejects.toThrow();
}, 15_000);

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderPath } from "@openorc/protocol";
import { versionOf, writeVersioned } from "./file-write.js";
import { WorkspaceWriters } from "./workspace-writers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), writeFile: vi.fn(actual.writeFile) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let dir: string;
let root: string;
let writers: WorkspaceWriters;
const absent = { kind: "absent" as const };
const file = FolderPath.parse("notes/today.md");

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "openorc-file-write-")));
  root = join(dir, "workspace");
  await fs.mkdir(root);
  writers = new WorkspaceWriters();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

it("refuses a lease that does not cover the file, so nothing writes around the reservation table", async () => {
  await fs.mkdir(join(dir, "other"));
  const lease = await writers.acquire(join(dir, "other"), "elsewhere");
  await expect(writeVersioned(lease, root, file, "x", absent)).rejects.toThrow("does not cover notes/today.md");
  lease.release();
  await expect(fs.access(join(root, "notes"))).rejects.toThrow();
});

it("falls back to a create-only write where hard links are unsupported, and still never replaces a file", async () => {
  const unsupported = () => Promise.reject(Object.assign(new Error("link not supported"), { code: "ENOTSUP" }));
  vi.mocked(fs.link).mockImplementation(unsupported);
  const lease = await writers.acquire(root, "editor");
  expect(await writeVersioned(lease, root, file, "first\n", absent)).toMatchObject({ kind: "written" });
  expect(await fs.readFile(join(root, file), "utf8")).toBe("first\n");
  expect(await writeVersioned(lease, root, file, "second\n", absent)).toEqual({ kind: "conflict" });
  expect(await fs.readFile(join(root, file), "utf8")).toBe("first\n");
  lease.release();
});

it("refuses text whose UTF-8 bytes exceed the two megabyte read limit, so every saved file can be opened again", async () => {
  const lease = await writers.acquire(root, "editor");
  await expect(writeVersioned(lease, root, file, "é".repeat(1024 * 1024 + 1), absent)).rejects.toThrow("too large to save");
  lease.release();
  await expect(fs.access(join(root, file))).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});

it("notices a file that changed while its temp file was being written, leaves the newer file alone, and removes the temp file", async () => {
  const target = join(root, file);
  await fs.mkdir(join(root, "notes"));
  await fs.writeFile(target, "original\n");
  const lease = await writers.acquire(root, "editor");
  const version = versionOf(Buffer.from("original\n"));
  vi.mocked(fs.writeFile).mockImplementationOnce(async (temporary, bytes, options) => {
    await actual.writeFile(target, "the agent's edit\n");
    return actual.writeFile(temporary, bytes, options);
  });
  expect(await writeVersioned(lease, root, file, "mine\n", { kind: "version", version })).toEqual({ kind: "conflict" });
  lease.release();
  expect(await fs.readFile(target, "utf8")).toBe("the agent's edit\n");
  expect(await fs.readdir(join(root, "notes"))).toEqual(["today.md"]);
});

it("holds create-only against a file that appears at the last instant, keeping that file", async () => {
  const target = join(root, file);
  const lease = await writers.acquire(root, "editor");
  vi.mocked(fs.link).mockImplementationOnce(async (temporary, destination) => {
    await actual.writeFile(target, "the agent's file\n");
    return actual.link(temporary, destination);
  });
  expect(await writeVersioned(lease, root, file, "mine\n", absent)).toEqual({ kind: "conflict" });
  lease.release();
  expect(await fs.readFile(target, "utf8")).toBe("the agent's file\n");
  expect(await fs.readdir(join(root, "notes"))).toEqual(["today.md"]);
});

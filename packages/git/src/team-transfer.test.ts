import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, run } from "./exec.js";
import { capture, listTree, materialize, readBlob, retainTree, stageMerge, type TeamTreeSnapshot } from "./team-transfer.js";

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-transfer-test-"));
  root = path.join(directory, "source");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "document.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  await writeFile(path.join(root, "delete.txt"), "Delete me\n");
  await writeFile(path.join(root, "rename.txt"), "Rename me\n");
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "Fixture baseline"]);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const prefix = () => `refs/openorc/team-transfer-tests/${randomUUID()}`;
const snapshot = (cwd = root, trackedTree?: string) => capture(cwd, { refPrefix: prefix(), ...(trackedTree ? { trackedTree } : {}) });
const indexBytes = async () => readFile(path.join(root, ".git", "index"));
const identity = async () => ({ head: (await git(root, ["rev-parse", "HEAD"])).stdout, branch: (await git(root, ["symbolic-ref", "HEAD"])).stdout, index: await indexBytes() });
async function worker(input: TeamTreeSnapshot) {
  const destination = path.join(directory, `worker-${randomUUID()}`);
  await materialize(root, { snapshot: input, path: destination });
  return destination;
}

describe("lossless team tree transfer", () => {
  it("captures and seeds binary files, executable modes, symlinks, and odd paths without touching partial staging", async () => {
    await writeFile(path.join(root, "document.txt"), "Staged content\n");
    await git(root, ["add", "document.txt"]);
    await writeFile(path.join(root, "document.txt"), "Different working content\r\n");
    const binary = randomBytes(1_300_007);
    const odd = '- odd\t"name\nwith space ';
    await writeFile(path.join(root, odd), binary);
    await writeFile(path.join(root, "executable"), "#!/bin/sh\nprintf ok\n");
    await chmod(path.join(root, "executable"), 0o755);
    await symlink(odd, path.join(root, "link"));
    const rawLink = Buffer.from([0x66, 0x6f, 0x80, 0xff]);
    await symlink(rawLink, path.join(root, "raw-link"));
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored", "secret"), "Excluded\n");
    const before = await identity();
    const captured = await snapshot();
    expect(captured.headSha).toBe(before.head.trim());
    expect(captured.branch).toBe("refs/heads/main");
    expect(await identity()).toEqual(before);
    expect((await git(root, ["cat-file", "-t", captured.treeRef])).stdout.trim()).toBe("tree");
    expect((await git(root, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    const copy = await worker(captured);
    expect(await readFile(path.join(copy, odd))).toEqual(binary);
    expect(await readFile(path.join(copy, "document.txt"), "utf8")).toBe("Different working content\r\n");
    expect(await readlink(path.join(copy, "link"))).toBe(odd);
    expect(await readlink(path.join(copy, "raw-link"), { encoding: "buffer" })).toEqual(rawLink);
    expect((await lstat(path.join(copy, "executable"))).mode & 0o111).toBe(0o111);
    expect((await git(copy, ["rev-parse", "HEAD"])).stdout).toBe(before.head);
    expect((await git(copy, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect((await listTree(root, captured.treeSha)).some((entry) => entry.path.startsWith("ignored/"))).toBe(false);
    expect((await snapshot(copy, captured.treeSha)).treeSha).toBe(captured.treeSha);
    await git(root, ["gc", "--prune=now"]);
    const blob = (await listTree(root, captured.treeSha)).find((entry) => entry.path === odd)!;
    expect(await readBlob(root, blob.oid)).toEqual(binary);
    expect(await identity()).toEqual(before);
  });

  it("unions inherited paths from additional trees while capturing their current bytes and deletions", async () => {
    const original = await snapshot();
    await writeFile(path.join(root, "accepted.txt"), "Accepted input\n");
    await writeFile(path.join(root, "removed.txt"), "Later removed\n");
    const accepted = await snapshot();
    await writeFile(path.join(root, ".gitignore"), "accepted.txt\nremoved.txt\n");
    await writeFile(path.join(root, "accepted.txt"), "Current filesystem bytes\n");
    await rm(path.join(root, "removed.txt"));
    const retained = await capture(root, { refPrefix: prefix(), trackedTree: original.treeSha, additionalTrackedTrees: [accepted.treeSha] });
    const entries = await listTree(root, retained.treeSha);
    expect(entries.some((entry) => entry.path === "removed.txt")).toBe(false);
    const entry = entries.find((entry) => entry.path === "accepted.txt");
    expect(entry).toBeDefined();
    expect(await readBlob(root, entry!.oid)).toEqual(Buffer.from("Current filesystem bytes\n"));
  });

  it("merges only assignment changes into independent destination edits, including binary, rename, delete and modes", async () => {
    const input = await snapshot();
    const copy = await worker(input);
    await writeFile(path.join(copy, "document.txt"), "one\ntwo\nthree\nfour\nfive\nworker six\n");
    await rm(path.join(copy, "delete.txt"));
    const renamed = "renamed\nwith tab\t.txt";
    await rename(path.join(copy, "rename.txt"), path.join(copy, renamed));
    await chmod(path.join(copy, renamed), 0o755);
    const binary = randomBytes(1_250_000);
    await writeFile(path.join(copy, "new.bin"), binary);
    await symlink(renamed, path.join(copy, "new-link"));
    const output = await snapshot(copy, input.treeSha);
    await writeFile(path.join(root, "document.txt"), "destination one\ntwo\nthree\nfour\nfive\nsix\n");
    await writeFile(path.join(root, "parent-only.txt"), "Keep this edit\n");
    const destination = await snapshot();
    const before = await identity();
    const merged = await stageMerge(root, {
      baseTree: input.treeSha,
      outputTree: output.treeSha,
      destinationTree: destination.treeSha,
      headSha: destination.headSha,
      path: path.join(directory, "merge"),
      refPrefix: prefix(),
    });
    expect(merged.status, JSON.stringify(merged)).toBe("clean");
    if (merged.status !== "clean") throw new Error("Expected clean merge");
    expect(await readFile(path.join(merged.worktreePath, "document.txt"), "utf8")).toBe("destination one\ntwo\nthree\nfour\nfive\nworker six\n");
    expect(await readFile(path.join(merged.worktreePath, "parent-only.txt"), "utf8")).toBe("Keep this edit\n");
    expect(await readFile(path.join(merged.worktreePath, "new.bin"))).toEqual(binary);
    expect(await readlink(path.join(merged.worktreePath, "new-link"))).toBe(renamed);
    const entries = await listTree(root, merged.treeSha);
    expect(entries.find((entry) => entry.path === renamed)?.mode).toBe("100755");
    expect(entries.some((entry) => entry.path === "delete.txt" || entry.path === "rename.txt")).toBe(false);
    expect(await identity()).toEqual(before);
    expect(await readFile(path.join(root, "document.txt"), "utf8")).toBe("destination one\ntwo\nthree\nfour\nfive\nsix\n");
    expect((await snapshot(merged.worktreePath, merged.treeSha)).treeSha).toBe(merged.treeSha);
  });

  it("retains divergent text, binary and delete conflicts in scratch without touching the destination", async () => {
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "clean.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    const input = await snapshot();
    const copy = await worker(input);
    await writeFile(path.join(copy, "document.txt"), "worker\n");
    await writeFile(path.join(copy, "binary.bin"), Buffer.from([0, 3, 4]));
    await writeFile(path.join(copy, "clean.txt"), "one\ntwo\nthree\nfour\nfive\nworker six\n");
    await rm(path.join(copy, "delete.txt"));
    const output = await snapshot(copy, input.treeSha);
    await writeFile(path.join(root, "document.txt"), "destination\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 5, 6]));
    await writeFile(path.join(root, "clean.txt"), "destination one\ntwo\nthree\nfour\nfive\nsix\n");
    await writeFile(path.join(root, "delete.txt"), "Locally edited\n");
    const destination = await snapshot();
    const before = await identity();
    const merged = await stageMerge(root, {
      baseTree: input.treeSha,
      outputTree: output.treeSha,
      destinationTree: destination.treeSha,
      headSha: destination.headSha,
      path: path.join(directory, "conflict"),
      refPrefix: prefix(),
    });
    expect(merged.status).toBe("conflict");
    if (merged.status !== "conflict") throw new Error("Expected conflict");
    expect(merged.conflicts.sort()).toEqual(["binary.bin", "delete.txt", "document.txt"]);
    expect((await git(merged.worktreePath, ["ls-files", "--unmerged"], { env: { GIT_INDEX_FILE: merged.indexPath } })).stdout).toContain("document.txt");
    expect(await readFile(path.join(merged.worktreePath, "document.txt"), "utf8")).toContain("<<<<<<< destination");
    expect(await readFile(path.join(merged.worktreePath, "binary.bin"))).toEqual(Buffer.from([0, 5, 6]));
    expect(await readFile(path.join(root, "document.txt"), "utf8")).toBe("destination\n");
    expect(await identity()).toEqual(before);
    const resolved = (await git(merged.worktreePath, ["ls-files", "--stage", "--", "clean.txt"], { env: { GIT_INDEX_FILE: merged.indexPath } })).stdout.split(" ")[1]!;
    await git(root, ["gc", "--prune=now"]);
    expect((await readBlob(root, resolved)).toString()).toBe("destination one\ntwo\nthree\nfour\nfive\nworker six\n");
    expect(merged.retainedRefs.some((ref) => ref.endsWith("/partial-tree"))).toBe(true);
  });

  it("rejects submodules and unsupported special files explicitly", async () => {
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
    await expect(snapshot()).rejects.toThrow(/submodules/);
    await git(root, ["update-index", "--force-remove", "submodule"]);
    await run("mkfifo", root, ["pipe"]);
    await expect(snapshot()).rejects.toThrow(/special file/);
  });

  it("retention refs are immutable and never replace an existing snapshot", async () => {
    const first = await snapshot();
    await writeFile(path.join(root, "document.txt"), "Changed\n");
    const second = await snapshot();
    await expect(retainTree(root, first.treeSha, first.treeRef)).resolves.toBeUndefined();
    await expect(retainTree(root, second.treeSha, first.treeRef)).rejects.toThrow(/different object/);
    await expect(retainTree(root, second.treeSha, "refs/heads/main")).rejects.toThrow(/retention refs/);
    expect((await git(root, ["rev-parse", first.treeRef])).stdout.trim()).toBe(first.treeSha);
  });

  it("captures directory-to-symlink replacements without reading through the new symlink", async () => {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "file.txt"), "Inherited\n");
    const before = await snapshot();
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    // Reading this FIFO as an inherited file would hang. The snapshot must treat
    // the former child as deleted and store only the replacement symlink.
    await run("mkfifo", outside, ["file.txt"]);
    await rm(path.join(root, "nested"), { recursive: true });
    await symlink(outside, path.join(root, "nested"));
    const captured = await snapshot(root, before.treeSha);
    const entries = await listTree(root, captured.treeSha);
    expect(entries.find((entry) => entry.path === "nested")?.mode).toBe("120000");
    expect(entries.some((entry) => entry.path === "nested/file.txt")).toBe(false);
    const copy = await worker(captured);
    expect(await readlink(path.join(copy, "nested"))).toBe(outside);
  });

  it("stages clean file-directory replacements and rejects existing scratch destinations", async () => {
    await mkdir(path.join(root, "was-directory"));
    await writeFile(path.join(root, "was-directory", "child"), "Child\n");
    const input = await snapshot();
    const copy = await worker(input);
    await rm(path.join(copy, "rename.txt"));
    await mkdir(path.join(copy, "rename.txt"));
    await writeFile(path.join(copy, "rename.txt", "child"), "New directory\n");
    await rm(path.join(copy, "was-directory"), { recursive: true });
    await writeFile(path.join(copy, "was-directory"), "New file\n");
    const output = await snapshot(copy, input.treeSha);
    const options = { baseTree: input.treeSha, outputTree: output.treeSha, destinationTree: input.treeSha, headSha: input.headSha, path: path.join(directory, "replace"), refPrefix: prefix() };
    const merged = await stageMerge(root, options);
    expect(merged.status).toBe("clean");
    expect(await readFile(path.join(merged.worktreePath, "rename.txt", "child"), "utf8")).toBe("New directory\n");
    expect(await readFile(path.join(merged.worktreePath, "was-directory"), "utf8")).toBe("New file\n");
    await expect(stageMerge(root, options)).rejects.toThrow(/must not already exist/);
  });

  it("hashes and seeds many files in batches with the same bytes and modes", async () => {
    const files = Array.from({ length: 1200 }, (_, index) => `many/${String(index).padStart(4, "0")}.txt`);
    for (const name of files) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), `content ${name}\n`);
    }
    await chmod(path.join(root, files[7]!), 0o755);
    const captured = await capture(root, { refPrefix: "refs/openorc/tests/many" });
    const entries = await listTree(root, captured.treeSha);
    expect(entries.filter((entry) => entry.path.startsWith("many/"))).toHaveLength(1200);
    expect(entries.find((entry) => entry.path === files[7])?.mode).toBe("100755");
    const copy = path.join(directory, "many-copy");
    await materialize(root, { snapshot: captured, path: copy });
    expect(await readFile(path.join(copy, files[1199]!), "utf8")).toBe(`content ${files[1199]}\n`);
    expect(((await stat(path.join(copy, files[7]!))).mode & 0o111) !== 0).toBe(true);
    expect((await git(copy, ["status", "--porcelain"])).stdout.split("\n").filter((line) => line.includes("many/"))).toHaveLength(1);
  });
});

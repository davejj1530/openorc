import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileVersion, type FileExpectation, type FolderPath } from "@openorc/protocol";
import { assertSafeParentPath } from "./safe-parent-path.js";
import { leaseCovers, type WorkspaceLease } from "./workspace-writers.js";

export type WriteOutcome = { kind: "written"; version: FileVersion } | { kind: "conflict" };

/** Files larger than reads allow can't be saved either, so a saved file can always be opened again. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** What is at the target now. `other` is a folder or an oversized file: never what a save expects, so the save is a conflict. */
type Current = { kind: "absent" } | { kind: "file"; version: FileVersion; bom: boolean; mode: number } | { kind: "other" };

export const versionOf = (bytes: Buffer): FileVersion => FileVersion.parse(createHash("sha256").update(bytes).digest("hex"));

async function current(target: string): Promise<Current> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return { kind: "absent" };
  // files.read names the file a link points at, so a link here means the folder changed under the edit.
  if (stat.isSymbolicLink()) throw new Error("This path is now a link to another file. Open the file again before saving.");
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { kind: "other" };
  const bytes = await readFile(target);
  return { kind: "file", version: versionOf(bytes), bom: bytes.subarray(0, 3).equals(BOM), mode: stat.mode & 0o777 };
}

const satisfies = (state: Current, expected: FileExpectation): boolean => (expected.kind === "absent" ? state.kind === "absent" : state.kind === "file" && state.version === expected.version);

/**
 * Publishes a new file. link() fails with EEXIST when a file appeared meanwhile, so create-only holds even against a
 * racing writer. A filesystem without hard links gets a create-only write instead.
 */
async function publishNew(temporary: string, target: string, bytes: Buffer): Promise<boolean> {
  const exists = (error: NodeJS.ErrnoException): boolean => {
    if (error.code === "EEXIST") return false;
    throw error;
  };
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return writeFile(target, bytes, { flag: "wx" }).then(() => true, exists);
  }
}

/**
 * Writes `text` to `root/path` if the file there is still as `expected`, atomically: an agent, a reader or a
 * checkpoint's tree hash sees the old file or the new one, never half of either.
 * - The lease is proof, not decoration. One that doesn't cover the file is refused, so nothing writes around
 *   WorkspaceWriters by importing this module.
 * - assertSafeParentPath runs before and after every wait: no `..` or `.git` segment, no symlinked parent, and the
 *   same directories (device and inode) throughout. Missing parents are created for a new file.
 * - The bytes go to `.openorc-<uuid>.tmp` beside the target with the target's permission bits, the target is checked
 *   against `expected` once more, then rename() replaces it or link() creates it. The temp file never survives.
 * - A byte order mark the current file starts with is written back; `text` never carries one.
 * The gap between the last check and the rename stays open: agents write without leases, so this narrows that race
 * without closing it.
 */
export async function writeVersioned(lease: WorkspaceLease, root: string, path: FolderPath, text: string, expected: FileExpectation): Promise<WriteOutcome> {
  const target = join(root, path);
  const directories = new Map<string, string>();
  await assertSafeParentPath(root, path, directories);
  const before = await current(target);
  if (!leaseCovers(lease, target)) throw new Error(`The workspace lease held for ${lease.owner} does not cover ${path}.`);
  if (!satisfies(before, expected)) return { kind: "conflict" };
  const bytes = before.kind === "file" && before.bom ? Buffer.concat([BOM, Buffer.from(text, "utf8")]) : Buffer.from(text, "utf8");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("This file is too large to save here (2 MB maximum).");
  await mkdir(dirname(target), { recursive: true });
  await assertSafeParentPath(root, path, directories);
  const temporary = join(dirname(target), `.openorc-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (before.kind === "file") await chmod(temporary, before.mode);
    await assertSafeParentPath(root, path, directories);
    if (!satisfies(await current(target), expected)) return { kind: "conflict" };
    if (expected.kind === "version") await rename(temporary, target);
    else if (!(await publishNew(temporary, target, bytes))) return { kind: "conflict" };
  } finally {
    await rm(temporary, { force: true });
  }
  return { kind: "written", version: versionOf(bytes) };
}

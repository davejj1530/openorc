import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, teamTransfer } from "@openorc/git";
import type { TeamPublicationRecord, TeamTreeEntry } from "@openorc/protocol";
import { assertSafeParentPath } from "./safe-parent-path.js";

export type TeamFilePublication = Pick<TeamPublicationRecord, "id" | "destinationPath" | "before" | "entries">;
export type TeamFilePublicationHook = (point: "before-write" | "after-write" | "before-receipt", receiptId: string, file?: string) => void | Promise<void>;
const same = (left: TeamTreeEntry | null, right: TeamTreeEntry | null) => left?.mode === right?.mode && left?.oid === right?.oid;

/** Caller journals the immutable delta and holds a physical writer lease through its receipt transaction. */
export async function publishTeamFiles(receipt: TeamFilePublication, assertActive: () => void, fault?: TeamFilePublicationHook): Promise<void> {
  const cwd = receipt.destinationPath;
  const beforePaths = await checkPublication(receipt);
  assertActive();
  const ordered = [...receipt.entries].sort((a, b) => Number(Boolean(a.after)) - Number(Boolean(b.after)) || b.path.split("/").length - a.path.split("/").length || a.path.localeCompare(b.path));
  for (const entry of ordered) {
    assertActive();
    await fault?.("before-write", receipt.id, entry.path);
    assertActive();
    await assertPublicationMetadata(receipt);
    await assertSafeParentPath(cwd, entry.path, beforePaths);
    const current = await readEntry(cwd, entry.path, receipt.before.treeSha.length);
    if (same(current, entry.after)) continue;
    if (!same(current, entry.before)) throw new Error(`External changes at ${entry.path} prevent publication. The file was preserved.`);
    const target = path.join(cwd, entry.path);
    if (!entry.after) {
      await assertSafeParentPath(cwd, entry.path, beforePaths);
      await rm(target);
    } else {
      const bytes = await teamTransfer.readBlob(cwd, entry.after.oid);
      await mkdir(path.dirname(target), { recursive: true });
      await assertSafeParentPath(cwd, entry.path, beforePaths);
      const temporary = path.join(path.dirname(target), `.openorc-${randomUUID()}.tmp`);
      try {
        if (entry.after.mode === "120000") await symlink(bytes, temporary);
        else {
          await writeFile(temporary, bytes, { flag: "wx", mode: entry.after.mode === "100755" ? 0o755 : 0o644 });
          await chmod(temporary, entry.after.mode === "100755" ? 0o755 : 0o644);
        }
        assertActive();
        await assertSafeParentPath(cwd, entry.path, beforePaths);
        if (!same(await readEntry(cwd, entry.path, receipt.before.treeSha.length), entry.before)) throw new Error(`External changes at ${entry.path} prevent publication.`);
        await assertSafeParentPath(cwd, entry.path, beforePaths);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await fault?.("after-write", receipt.id, entry.path);
  }
  assertActive();
  await assertPublicationMetadata(receipt);
  for (const entry of receipt.entries)
    if (!same(await readEntry(cwd, entry.path, receipt.before.treeSha.length), entry.after)) throw new Error(`Published file ${entry.path} changed before verification.`);
  await fault?.("before-receipt", receipt.id);
  assertActive();
  await assertPublicationMetadata(receipt);
  for (const entry of receipt.entries) {
    await assertSafeParentPath(cwd, entry.path, beforePaths);
    if (!same(await readEntry(cwd, entry.path, receipt.before.treeSha.length), entry.after)) throw new Error(`Published file ${entry.path} changed before its receipt was recorded.`);
  }
}

export async function checkPublication(receipt: TeamFilePublication): Promise<Map<string, string>> {
  await assertPublicationMetadata(receipt);
  // The same parent identities guard the recovered before/after state and every later write.
  // A failed check leaves the durable receipt for explicit recovery; it never resets files.
  const directories = new Map<string, string>();
  for (const entry of receipt.entries) {
    await assertSafeParentPath(receipt.destinationPath, entry.path, directories);
    const current = await readEntry(receipt.destinationPath, entry.path, receipt.before.treeSha.length);
    if (!same(current, entry.before) && !same(current, entry.after)) throw new Error(`External changes at ${entry.path} prevent recovery. No files were reset.`);
  }
  return directories;
}

export async function assertPublicationMetadata(receipt: TeamFilePublication): Promise<void> {
  const cwd = receipt.destinationPath;
  if ((await realpath(cwd)) !== receipt.before.rootPath) throw new Error("The destination path now points to another workspace.");
  const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).stdout.trim() || null;
  // Staging is compared by index content, like the capture guard: a provider refreshing stat data is not a change.
  const digest = await teamTransfer.indexContentDigest(cwd);
  if (head !== receipt.before.headSha || branch !== receipt.before.branch || digest !== receipt.before.indexSha256)
    throw new Error("Destination HEAD, branch or staging changed. Integration is paused without changing that state.");
}

async function readEntry(cwd: string, file: string, shaLength: number): Promise<TeamTreeEntry | null> {
  const target = path.join(cwd, file);
  const stat = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported filesystem entry at ${file}.`);
  const bytes = stat.isSymbolicLink() ? await readlink(target, { encoding: "buffer" }) : await readFile(target);
  const oid = createHash(shaLength === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  return { path: file, mode: entryMode(stat), oid };
}

function entryMode(stat: { isSymbolicLink(): boolean; mode: number }): "120000" | "100755" | "100644" {
  if (stat.isSymbolicLink()) return "120000";
  if ((stat.mode & 0o111) !== 0) return "100755";
  return "100644";
}

import os from "node:os";
import path from "node:path";
import { activityImagePath, messageText, projects, runs, tasks, threads, type Db, type LedgerWriter } from "@openorc/db";
import { FolderPath, type AssetRef, type FileRead } from "@openorc/protocol";
import { profileAssetPath, RASTER_IMAGE_TYPES, readImageFile, type ImageFileRead } from "../services/profile-assets.js";

export interface AssetSources {
  dataDir: string;
  db: Db;
  ledger: LedgerWriter;
  /** A file of a thread's folder as files.read reads it for that thread: its folder on this Mac, or a cloud thread's copy. */
  fileRead: (threadId: string, path: FolderPath) => Promise<FileRead>;
}

/** The folder a run worked in, where a relative path in its reply resolves: its thread's or task's worktree, else the project. */
function runFolder(db: Db, runId: string): string | null {
  const run = runs.get(db, runId);
  const thread = run?.threadId ? threads.get(db, run.threadId) : null;
  const owner: { worktreePath: string | null; projectId: string } | null = thread ?? (run?.taskId ? tasks.get(db, run.taskId) : null);
  if (!owner) return null;
  return owner.worktreePath ?? projects.get(db, owner.projectId)?.rootPath ?? null;
}

/**
 * The file an image in a reply names, only when the message itself names it: a phone asks by the message and the path
 * as written, never for a file the agent did not show. Absolute, `~/` and `file://` paths read as they are; a relative
 * one from the folder the run worked in.
 */
function replyImagePath(ref: Extract<AssetRef, { kind: "reply-image" }>, { db, ledger }: AssetSources): string | null {
  // The message may have completed a moment ago and still be queued for the ledger.
  ledger.flush();
  const text = messageText(db, ref.runId, ref.messageId);
  if (!text?.includes(ref.path)) return null;
  let written = ref.path.replace(/^file:\/\//, "");
  try {
    written = decodeURI(written);
  } catch {
    // A path with a stray % is read as written.
  }
  if (written.startsWith("~/")) return path.join(os.homedir(), written.slice(2));
  if (path.isAbsolute(written)) return written;
  const folder = runFolder(db, ref.runId);
  return folder ? path.resolve(folder, written) : null;
}

/** The file an asset reference names. An activity's image and a reply's image live outside the profile, where their run put them. */
function assetPath(ref: Exclude<AssetRef, { kind: "thread-file" }>, sources: AssetSources): string | null {
  const { dataDir, db, ledger } = sources;
  switch (ref.kind) {
    case "attachment":
      return profileAssetPath(`openorc-asset://attachments/${ref.name}`, dataDir);
    case "tool-image":
      return profileAssetPath(ref.url, dataDir);
    case "activity":
      // The activity may have arrived in a frame a moment ago and still be queued for the ledger.
      ledger.flush();
      return activityImagePath(db, ref.runId, ref.activityId);
    case "reply-image":
      return replyImagePath(ref, sources);
    case "preview":
      // A Preview frame is never a file; the session serves it from its caster.
      return null;
  }
}

/** A phone's image, by a reference its transcript holds. Raster images only, whatever the desktop shows. */
export async function readRemoteAsset(ref: AssetRef, sources: AssetSources): Promise<ImageFileRead> {
  if (ref.kind === "thread-file") return threadFileImage(ref, sources);
  const file = assetPath(ref, sources);
  return file ? readImageFile(file, RASTER_IMAGE_TYPES) : { ok: false, reason: "missing" };
}

/** An image in a thread's folder, by its place there alone, found as files.read finds it: never a path outside the folder. */
async function threadFileImage(ref: Extract<AssetRef, { kind: "thread-file" }>, sources: AssetSources): Promise<ImageFileRead> {
  const place = FolderPath.safeParse(ref.path);
  if (!place.success) return { ok: false, reason: "missing" };
  const read = await sources.fileRead(ref.threadId, place.data);
  return read.kind === "binary" && read.media === "image" ? readImageFile(read.absolutePath, RASTER_IMAGE_TYPES) : { ok: false, reason: "missing" };
}

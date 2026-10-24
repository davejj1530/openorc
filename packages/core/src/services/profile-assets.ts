import { open } from "node:fs/promises";
import path from "node:path";
import { TOOL_IMAGE_URL } from "@openorc/protocol";

/**
 * Which image files may leave the profile by reference, shared by the desktop's asset protocol and phone access so
 * the two cannot disagree. Only names the app itself writes resolve, so no reference can climb out of its folder.
 */

const ATTACHMENT_URL = /^openorc-asset:\/\/attachments\/([a-f0-9-]+\.(?:png|jpg|gif|webp))$/;

export const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

export const RASTER_IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The file an `openorc-asset://attachments/...` or `openorc-asset://tool-images/...` URL names, or null. */
export function profileAssetPath(url: string, dataDir: string): string | null {
  const attachment = ATTACHMENT_URL.exec(url);
  if (attachment) return path.join(dataDir, "attachments", attachment[1]!);
  const toolImage = TOOL_IMAGE_URL.exec(url);
  return toolImage ? path.join(dataDir, "tool-images", toolImage[1]!, toolImage[2]!) : null;
}

export type ImageFileRead = { ok: true; mime: string; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "unsupported" | "missing" | "too-large" };

/** Reads one regular file whose extension `types` lists, at most MAX_IMAGE_FILE_BYTES, checked on the open handle. */
export async function readImageFile(file: string, types: Readonly<Record<string, string>>): Promise<ImageFileRead> {
  const extension = path.extname(file).toLowerCase();
  const mime = Object.hasOwn(types, extension) ? types[extension] : undefined;
  if (!mime) return { ok: false, reason: "unsupported" };
  if (!path.isAbsolute(file) || file.includes("\0")) return { ok: false, reason: "missing" };
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: "missing" };
    if (stat.size > MAX_IMAGE_FILE_BYTES) return { ok: false, reason: "too-large" };
    return { ok: true, mime, bytes: new Uint8Array(await handle.readFile()) };
  } catch {
    return { ok: false, reason: "missing" };
  } finally {
    await handle.close();
  }
}

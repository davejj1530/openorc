import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SignedFileUrl } from "@openorc/protocol";

/** The app's scheme for a file's bytes. Main serves it; only a URL the core signed names a file. */
export const FILE_SCHEME = "openorc-file";

const signature = (key: string, absolutePath: string): string => createHmac("sha256", key).update(absolutePath).digest("hex");

/**
 * The URL the renderer loads a contained file's bytes from. Only main, holding the same key, turns it back into a path.
 * `version` changes when the bytes do, so a rewritten file gets a new URL and its viewer reloads; it is not signed, and
 * main ignores it.
 */
export function signFileUrl(key: string, absolutePath: string, version: string): SignedFileUrl {
  return `${FILE_SCHEME}://file/?path=${encodeURIComponent(absolutePath)}&sig=${signature(key, absolutePath)}&v=${encodeURIComponent(version)}` as SignedFileUrl;
}

/** The path a URL from signFileUrl names, or null for anything not signed with `key`. The comparison takes the same time whatever differs. */
export function verifyFileUrl(key: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${FILE_SCHEME}:` || parsed.hostname !== "file") return null;
  const path = parsed.searchParams.get("path");
  const given = parsed.searchParams.get("sig");
  if (!path || !given || !isAbsolute(path) || path.includes("\0")) return null;
  const expected = Buffer.from(signature(key, path));
  const offered = Buffer.from(given);
  return offered.length === expected.length && timingSafeEqual(offered, expected) ? path : null;
}

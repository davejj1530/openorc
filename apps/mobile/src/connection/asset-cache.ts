import type { AssetRef } from "@openorc/protocol";
import { Directory, File, Paths } from "expo-file-system";
import type { Asset } from "./link-connection";

const folder = (macId: string) => new Directory(Paths.cache, "assets", macId);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The extension each image type is kept under: iOS types a shared file by its name, so Share offers Save Image. */
const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const KEPT = [...new Set(Object.values(EXTENSIONS)), ""];

/**
 * Images a transcript names, fetched from the Mac once and kept in a folder per Mac, so a view shows them by a
 * `file://` URI. The system may empty the cache folder; an image then comes from the Mac again.
 */
export function createAssetCache(fetch: (ref: AssetRef) => Promise<Asset>, sha256: (bytes: Uint8Array) => Uint8Array) {
  const loading = new Map<string, Promise<string>>();

  async function load(macId: string, name: string, ref: AssetRef): Promise<string> {
    const { bytes, mime } = await fetch(ref);
    const file = new File(folder(macId), `${name}${EXTENSIONS[mime] ?? ""}`);
    if (!file.parentDirectory.exists) file.parentDirectory.create({ intermediates: true });
    await file.write(bytes);
    return file.uri;
  }

  return {
    uri(macId: string, ref: AssetRef): Promise<string> {
      const name = hex(sha256(new TextEncoder().encode(JSON.stringify(ref))));
      const kept = KEPT.map((extension) => new File(folder(macId), `${name}${extension}`)).find((file) => file.exists);
      if (kept) return Promise.resolve(kept.uri);
      const key = `${macId}/${name}`;
      const pending = loading.get(key) ?? load(macId, name, ref).finally(() => loading.delete(key));
      loading.set(key, pending);
      return pending;
    },
    forget(macId: string): void {
      const cached = folder(macId);
      if (cached.exists) cached.delete();
    },
  };
}

import type { AssetRef } from "@openorc/protocol";
import { Directory, File, Paths } from "expo-file-system";
import type { Asset } from "./link-connection";

const folder = (macId: string) => new Directory(Paths.cache, "assets", macId);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Images a transcript names, fetched from the Mac once and kept in a folder per Mac, so a view shows them by a
 * `file://` URI. The system may empty the cache folder; an image then comes from the Mac again.
 */
export function createAssetCache(fetch: (ref: AssetRef) => Promise<Asset>, sha256: (bytes: Uint8Array) => Uint8Array) {
  const loading = new Map<string, Promise<string>>();

  async function load(file: File, ref: AssetRef): Promise<string> {
    const { bytes } = await fetch(ref);
    if (!file.parentDirectory.exists) file.parentDirectory.create({ intermediates: true });
    await file.write(bytes);
    return file.uri;
  }

  return {
    uri(macId: string, ref: AssetRef): Promise<string> {
      const file = new File(folder(macId), hex(sha256(new TextEncoder().encode(JSON.stringify(ref)))));
      if (file.exists) return Promise.resolve(file.uri);
      const pending = loading.get(file.uri) ?? load(file, ref).finally(() => loading.delete(file.uri));
      loading.set(file.uri, pending);
      return pending;
    },
    forget(macId: string): void {
      const cached = folder(macId);
      if (cached.exists) cached.delete();
    },
  };
}

import type { FileByteSource, Hosted } from "@openorc/hosted";
import { hostedFileReference, type HostedFileScope } from "@openorc/protocol";
import { Directory, File, Paths } from "expo-file-system";

/** A file on the phone read where an upload asks, until `close`. */
export function phoneFile(uri: string): { source: FileByteSource; close(): void } {
  const handle = new File(uri).open();
  const source = {
    bytes: handle.size ?? 0,
    read: (offset: number, length: number) => {
      handle.offset = offset;
      return handle.readBytes(length);
    },
  };
  return { source, close: () => handle.close() };
}

const folder = (scope: HostedFileScope) => new Directory(Paths.cache, "cloud-files", scope.spaceId);

/**
 * A file a cloud message carries, read through the phone's own session once and kept in the cache, so a view shows it
 * by a `file://` URI. The system may empty the cache; the file is then read again.
 */
export async function cloudFileUri(hosted: Hosted, scope: HostedFileScope, path: string): Promise<string> {
  const reference = hostedFileReference(path);
  if (!reference) throw new Error("This file isn't available in this space.");
  const kept = new File(folder(scope), `${reference.id}-${reference.name}`);
  if (kept.exists) return kept.uri;
  const bytes = await hosted.files.read(scope, reference, false, async (response) => new Uint8Array(await response.arrayBuffer()));
  if (!kept.parentDirectory.exists) kept.parentDirectory.create({ intermediates: true });
  await kept.write(bytes);
  return kept.uri;
}

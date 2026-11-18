import type { FileByteSource, Hosted } from "@openorc/hosted";
import { hostedFileReference, type HostedFileScope, type TeamChatFile } from "@openorc/protocol";
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

/** A file read through the phone's own session once and kept in the cache in a folder of its id, by its own name, which Share then offers. */
async function keptFile(hosted: Hosted, scope: HostedFileScope, reference: { id: string; name: string }): Promise<string> {
  const kept = new File(folder(scope), reference.id, reference.name);
  if (kept.exists) return kept.uri;
  const bytes = await hosted.files.read(scope, reference, false, async (response) => new Uint8Array(await response.arrayBuffer()));
  if (!kept.parentDirectory.exists) kept.parentDirectory.create({ intermediates: true });
  await kept.write(bytes);
  return kept.uri;
}

/**
 * A file a cloud message carries, read through the phone's own session once and kept in the cache, so a view shows it
 * by a `file://` URI. The system may empty the cache; the file is then read again.
 */
export async function cloudFileUri(hosted: Hosted, scope: HostedFileScope, path: string): Promise<string> {
  const reference = hostedFileReference(path);
  if (!reference) throw new Error("This file isn't available in this space.");
  return keptFile(hosted, scope, reference);
}

/** A file a team chat message carries, kept as a cloud message's is. */
export const chatFileUri = (hosted: Hosted, scope: HostedFileScope, file: TeamChatFile): Promise<string> => keptFile(hosted, scope, { id: file.id, name: file.name });

/**
 * A picture in a cloud thread's folder, read from OpenOrc Cloud through the phone's own session and kept in the cache
 * by its place, so a view shows it by a `file://` URI. Read again each time it is asked, as the folder may have moved on.
 */
export async function threadFileUri(hosted: Hosted, threadId: string, path: string): Promise<string> {
  if (!hosted.threads.holds({ thread: threadId })) throw new Error("This thread isn't on OpenOrc Cloud.");
  const space = hosted.threads.row!(threadId).space;
  const response = await hosted.threadFiles.raw(space, threadId, path, AbortSignal.timeout(60_000));
  const kept = new File(new Directory(Paths.cache, "thread-files", threadId), encodeURIComponent(path));
  if (!kept.parentDirectory.exists) kept.parentDirectory.create({ intermediates: true });
  await kept.write(new Uint8Array(await response.arrayBuffer()));
  return kept.uri;
}

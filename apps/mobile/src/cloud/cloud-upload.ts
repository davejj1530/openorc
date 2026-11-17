import type { FileByteSource, Hosted } from "@openorc/hosted";
import { hostedFilePath, type HostedFileScope } from "@openorc/protocol";

/** Where a file goes on OpenOrc Cloud: an open cloud thread, or the cloud project a new thread starts in, in its space. */
export type CloudPlace = { threadId: string } | { projectKey: string; spaceId: string };

/**
 * The place a file goes, as the phone's own session knows it: the signed-in person, the server, and the thread's own
 * space and project, which the session heard with the thread. Null while the session holds neither.
 */
export function cloudFileScope(hosted: Hosted, place: CloudPlace): HostedFileScope | null {
  const status = hosted.spaces.status();
  if (status.state !== "ready") return null;
  const person = { accountId: status.userId, apiOrigin: status.apiOrigin };
  if ("threadId" in place) {
    const row = hosted.threads.holds({ thread: place.threadId }) ? hosted.threads.row?.(place.threadId) : undefined;
    return row?.projectId ? { ...person, spaceId: row.space, destination: { kind: "hosted", projectId: row.projectId, threadId: place.threadId } } : null;
  }
  const project = hosted.threads.cloudProjectFor?.(place.projectKey, place.spaceId);
  return project ? { ...person, spaceId: project.space, destination: { kind: "hosted", projectId: project.id } } : null;
}

/**
 * Sends a file to OpenOrc Cloud through the phone's own session, a part at a time, each read from `source` as it goes,
 * and resolves with the path a message carries for it.
 */
export async function uploadToCloud(hosted: Hosted, scope: HostedFileScope, file: { name: string; source: FileByteSource }): Promise<string> {
  const plan = await hosted.files.start(scope, { name: file.name, bytes: file.source.bytes, requestId: crypto.randomUUID() });
  const signal = new AbortController().signal;
  for (let part = 1; part <= plan.parts; part++) await hosted.files.part(scope, plan, part, file.source, { signal, progress: () => undefined });
  return hostedFilePath(await hosted.files.complete(scope, plan.id));
}

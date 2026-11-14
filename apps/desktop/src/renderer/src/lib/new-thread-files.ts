import type { HostedFileScope } from "@openorc/protocol";
import { useHostedFileContext } from "./hosted-file-scope";
import { forgetHostedIntent, hostedIntentId } from "./hosted-send-intent";

/**
 * A new thread's files. Starting on this Mac they are this project's attachments, as always. Starting on OpenOrc Cloud
 * they are a draft of the signed-in person in the selected space, uploaded there before the start, and the start goes
 * under one request id while its words, files and settings stay the same, so sending it again after a lost answer
 * makes no second thread.
 */
export function useNewThreadFiles(projectId: string, hosted: boolean) {
  const context = useHostedFileContext({ projectId, enabled: hosted });
  const identity = hosted ? context.identity : null;
  const key = identity ? `newthread.hosted.${identity.accountId}.${identity.spaceId}.${projectId}` : null;
  if (!hosted) return { draftKey: `newthread.${projectId}.attachments`, hostedFiles: undefined, requestId: async () => undefined, started: () => undefined };
  const hostedFiles: HostedFileScope | null = key ? context.scope : null;
  return {
    draftKey: `${key ?? `newthread.hosted.${projectId}`}.attachments`,
    hostedFiles,
    /** The start's request id when it carries cloud files; none otherwise. */
    requestId: async (intent: { text: string; attachments: string[]; settings: unknown }): Promise<string | undefined> =>
      key && intent.attachments.length ? hostedIntentId(key, { projectId, ...intent }) : undefined,
    started: () => {
      if (key) forgetHostedIntent(key);
    },
  };
}

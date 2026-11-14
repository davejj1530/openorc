import type { HostedFileDraft } from "@openorc/protocol";
import { HostedAttachmentImports } from "./hosted-attachment-imports";
import { HostedAttachmentStore } from "./hosted-attachment-store";
import { core } from "./rpc";

/** Shared by conversations and chat; neither keeps a second upload queue. */
export const hostedAttachments = new HostedAttachmentImports({
  store: new HostedAttachmentStore(),
  port: {
    capture: (input) => core.call("hostedFiles.capture", input),
    state: (input) => core.call("hostedFiles.state", input),
    begin: (input) => core.call("hostedFiles.begin", input),
    append: (input) => core.call("hostedFiles.append", input),
    finish: (input) => core.call("hostedFiles.finish", input),
    retry: (input) => core.call("hostedFiles.retry", input),
    remove: (input) => core.call("hostedFiles.remove", input),
    accepted: (input) => core.call("hostedFiles.accepted", input),
  },
});

/** Pending selections count as part of a draft before a task or another message may replace it. */
export async function hostedDraftFiles(draft: HostedFileDraft) {
  return hostedAttachments.files(await hostedAttachments.capture(draft));
}
